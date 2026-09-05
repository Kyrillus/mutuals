/**
 * §4.8's quick capture, the half that decides.
 *
 * The model returns slugs and strings. This file checks every slug against the resolver, every
 * value against the attribute type registry, every interaction type against the closed set, and
 * every date against the civil-date parser — and then runs §4.6's **deterministic** matcher over
 * what survived. The model has no way to say "this is Anna Berger, id abc"; it says "Anna Berger",
 * and `matchDuplicates` decides whether that is somebody we already have (§4.8, ADR-067).
 *
 * That matcher is the same one the importer uses, with the thresholds ADR-099 moved in Stage 5.
 * Quick capture inherits them, which is intended: a typo in a name typed at a conference and a typo
 * in a name exported from LinkedIn are the same problem, and having two answers to it would be the
 * bug.
 *
 * **A field the model got wrong is dropped, not fatal.** A capture that refuses the whole note
 * because one date did not parse is worse than one that saves the rest and says what it left out —
 * the user is looking at a preview, and the missing field is the one thing they can fix in a second.
 */
import {
  matchDuplicates,
  parseCivil,
  type AttributeDefinition,
  type CoreIssue,
  type DuplicateMatch,
  type FieldDescriptor,
  type FieldResolver,
  type IdentifierRef,
} from '@mutuals/core'
import { emailMatchKey, normalizeEmail } from '@mutuals/core'
import { normalizeLinkedIn } from '@mutuals/core'
import {
  findRecordsByLabel,
  probeDuplicates,
  INTERACTION_TYPES,
  type Executor,
  type InteractionType,
} from '@mutuals/db'

import type { LlmClient, RunOptions } from '../client.ts'
import { quickCapturePrompt, type QuickCaptureOutput } from '../prompts/quick-capture.ts'
import { promptFieldsFor } from './ask.ts'
import type { PromptField } from '../prompts/ask-filter.ts'

/** One proposed value, after the registry has accepted it. */
export interface CapturedField {
  readonly slug: string
  readonly label: string
  readonly value: string
  readonly confidence: number
}

/** A candidate the matcher offered, with the label the user will recognise it by. */
export interface CapturedMatch extends DuplicateMatch {
  readonly displayName: string
}

export interface CapturedRecord {
  readonly displayName: string
  readonly fields: readonly CapturedField[]
  readonly matches: readonly CapturedMatch[]
}

export interface CapturedInteraction {
  readonly type: InteractionType
  readonly title: string
  readonly body: string | null
  readonly occurredAt: string
}

export interface CapturedFollowUp {
  readonly title: string
  readonly dueAt: string
  readonly notes: string | null
}

export interface CapturedProposal {
  readonly contact: CapturedRecord | null
  readonly organization: CapturedRecord | null
  readonly interaction: CapturedInteraction | null
  readonly followUp: CapturedFollowUp | null
  readonly note: string | null
  readonly callIds: readonly string[]
}

export interface CaptureSchemas {
  readonly contact: FieldResolver
  readonly organization: FieldResolver
}

export interface ProposeCaptureInput {
  readonly text: string
  readonly today: string
  /** The instant, for an interaction the model dated as "today" — see {@link buildInteraction}. */
  readonly now: string
  readonly timeZone: string
  readonly schemas: CaptureSchemas
  /** Validates a batch of values against the attribute registry; the API owns the type context. */
  readonly validate: (
    objectType: 'contact' | 'organization',
    values: Readonly<Record<string, unknown>>,
  ) => readonly CoreIssue[]
}

/**
 * Only the fields a capture may fill.
 *
 * `display_name` is generated, `warmth` is derived, `created_at` is the database's — offering any
 * of them would produce a proposal that cannot be written and a preview row that does nothing.
 * Read off `readOnly`, so a new derived column is excluded the day it is added.
 */
export function writableFieldsFor(resolver: FieldResolver): readonly PromptField[] {
  const writable = new Set(
    resolver
      .list()
      .filter((field) => !field.readOnly)
      .map((field) => field.slug),
  )
  return promptFieldsFor(resolver).filter((field) => writable.has(field.slug))
}

export async function proposeCapture(
  exec: Executor,
  llm: LlmClient,
  input: ProposeCaptureInput,
  options: RunOptions,
): Promise<CapturedProposal> {
  const run = await llm.run(
    exec,
    quickCapturePrompt,
    {
      text: input.text,
      today: input.today,
      timeZone: input.timeZone,
      contactFields: [...writableFieldsFor(input.schemas.contact)],
      organizationFields: [...writableFieldsFor(input.schemas.organization)],
      interactionTypes: [...INTERACTION_TYPES],
      problems: [],
    },
    options,
  )

  const dropped: string[] = []
  const contact = buildRecord(run.value.contact, input.schemas.contact, 'contact', input, dropped)
  const organization = buildRecord(
    run.value.organization,
    input.schemas.organization,
    'organization',
    input,
    dropped,
  )

  const [contactMatches, organizationMatches] = await Promise.all([
    contact === null ? Promise.resolve([]) : matchContact(exec, contact, input.schemas.contact),
    organization === null ? Promise.resolve([]) : matchOrganization(exec, organization),
  ])

  // The matcher answers in record ids; the preview has to show names. One read for both records'
  // candidates rather than one per chip.
  const labels = await labelsFor(exec, [...contactMatches, ...organizationMatches])

  return {
    contact: contact === null ? null : { ...contact, matches: withLabels(contactMatches, labels) },
    organization:
      organization === null
        ? null
        : { ...organization, matches: withLabels(organizationMatches, labels) },
    interaction: buildInteraction(run.value.interaction, input, dropped),
    followUp: buildFollowUp(run.value.followUp, input, dropped),
    note: composeNote(run.value.note, dropped),
    callIds: run.callId === null ? [] : [run.callId],
  }
}

type Draft = Omit<CapturedRecord, 'matches'>

/**
 * The model's proposal for one record, with every field it got wrong removed.
 *
 * Values are collected per slug first, because a repeatable field arrives as several entries and
 * the registry validates the whole list at once — `tags` with one bad element is one issue about
 * `asks`, not an issue about the third `asks`.
 */
function buildRecord(
  proposed: QuickCaptureOutput['contact'],
  resolver: FieldResolver,
  objectType: 'contact' | 'organization',
  input: ProposeCaptureInput,
  dropped: string[],
): Draft | null {
  if (proposed === null) return null
  const displayName = proposed.displayName.trim()
  if (displayName === '') return null

  const writable = new Set(writableFieldsFor(resolver).map((field) => field.slug))
  const kept: CapturedField[] = []
  const attributeValues: Record<string, unknown> = {}

  for (const field of proposed.fields) {
    const descriptor = resolver.get(field.slug)
    const value = field.value.trim()
    if (descriptor === undefined || !writable.has(field.slug) || value === '') {
      if (descriptor === undefined) dropped.push(field.slug)
      continue
    }
    kept.push({
      slug: field.slug,
      label: descriptor.label,
      value,
      confidence: clamp(field.confidence),
    })
    if (descriptor.source.kind === 'attribute') {
      collect(attributeValues, descriptor, value)
    }
  }

  // The registry has the last word on every value, exactly as an ordinary create would.
  const issues = input.validate(objectType, attributeValues)
  const rejected = new Set(issues.map((issue) => String(issue.path[1] ?? '')))
  if (rejected.size > 0) dropped.push(...rejected)

  return {
    displayName,
    fields: withNameFields(
      kept.filter((field) => !rejected.has(field.slug)),
      displayName,
      resolver,
    ),
  }
}

/**
 * The name fields, filled from `displayName` when the model left them out.
 *
 * Without this the preview shows a card headed "Anna Berger" whose confirmed payload has no name in
 * it, and the commit creates a nameless record — the preview and what it writes have to be the same
 * thing. The model is *told* to emit them, so this is a fallback rather than the normal path.
 *
 * The split is the ordinary one: the last whitespace-separated token is the surname and everything
 * before it is the given name. Wrong for some names in some cultures, which is exactly why it only
 * fires when the model gave nothing and why both fields are editable in the preview.
 */
function withNameFields(
  fields: readonly CapturedField[],
  displayName: string,
  resolver: FieldResolver,
): readonly CapturedField[] {
  const present = new Set(fields.map((field) => field.slug))
  const extra: CapturedField[] = []

  const add = (slug: string, value: string): void => {
    const descriptor = resolver.get(slug)
    if (descriptor === undefined || present.has(slug) || value === '') return
    // Confidence 1: this is not the model's guess, it is the name the capture is about.
    extra.push({ slug, label: descriptor.label, value, confidence: 1 })
  }

  if (resolver.objectType === 'organization') {
    add('name', displayName)
    return [...extra, ...fields]
  }

  const parts = displayName.split(/\s+/).filter((part) => part !== '')
  if (parts.length === 1) {
    add('last_name', parts[0] ?? '')
  } else if (parts.length > 1) {
    add('first_name', parts.slice(0, -1).join(' '))
    add('last_name', parts[parts.length - 1] ?? '')
  }
  return [...extra, ...fields]
}

/** A repeatable field collects into an array; a single-valued one keeps the last value seen. */
function collect(into: Record<string, unknown>, descriptor: FieldDescriptor, value: string): void {
  if (!descriptor.isMulti) {
    into[descriptor.slug] = value
    return
  }
  const existing = into[descriptor.slug]
  const list: string[] = Array.isArray(existing) ? (existing as string[]) : []
  into[descriptor.slug] = [...list, value]
}

function clamp(confidence: number): number {
  if (!Number.isFinite(confidence)) return 0
  return Math.min(1, Math.max(0, confidence))
}

/**
 * §4.6's matcher, over what the model extracted.
 *
 * The identifiers go through `packages/core`'s normalisers rather than being taken as typed, for
 * the same reason the importer does it: `identifier.value` is canonical by definition, so a probe
 * against it has to be canonical too. A value that will not normalise contributes no identity
 * claim — it is still a perfectly good attribute value.
 */
async function matchContact(
  exec: Executor,
  draft: Draft,
  resolver: FieldResolver,
): Promise<readonly DuplicateMatch[]> {
  const identifiers: IdentifierRef[] = []
  const emailMatchKeys: string[] = []

  for (const field of draft.fields) {
    const descriptor = resolver.get(field.slug)
    const definition = definitionOf(descriptor)
    if (definition === undefined) continue

    if (definition.type === 'email') {
      const normalized = normalizeEmail(field.value)
      if (normalized.ok) {
        identifiers.push({ kind: 'email', value: normalized.value.identifier })
        emailMatchKeys.push(emailMatchKey(normalized.value.identifier))
      }
    }
    if (definition.type === 'url') {
      const normalized = normalizeLinkedIn(field.value)
      if (normalized.ok) {
        identifiers.push({ kind: 'linkedin_url', value: normalized.value.identifier })
      }
    }
  }

  // The organisations the capture names, where one already exists. Empty is the *correct* answer
  // for a brand-new company, and it is also the value that quietly disabled both name rules in the
  // importer's first version (ADR-100) — so it is computed rather than defaulted.
  const organizationIds = await relationTargets(exec, draft, resolver)

  const [probe] = await probeDuplicates(exec, [
    {
      objectType: 'contact',
      displayName: draft.displayName,
      identifiers,
      emailMatchKeys,
      organizationIds,
    },
  ])
  if (probe === undefined) return []

  const verdict = matchDuplicates(
    {
      objectType: 'contact',
      nameKey: probe.nameKey,
      identifiers,
      emailMatchKeys,
      organizationIds,
    },
    probe.pool,
  )
  return verdict.matches
}

async function labelsFor(
  exec: Executor,
  matches: readonly DuplicateMatch[],
): Promise<ReadonlyMap<string, string>> {
  const ids = [...new Set(matches.map((match) => match.recordId))]
  if (ids.length === 0) return new Map()
  const rows = await exec
    .selectFrom('record')
    .select(['id', 'display_label'])
    .where('id', 'in', ids)
    .execute()
  return new Map(rows.map((row) => [row.id, row.display_label]))
}

function withLabels(
  matches: readonly DuplicateMatch[],
  labels: ReadonlyMap<string, string>,
): readonly CapturedMatch[] {
  return matches.map((match) => ({
    ...match,
    // A record whose label read as empty is still a record; falling back to the id keeps the chip
    // clickable rather than blank.
    displayName: labels.get(match.recordId) ?? match.recordId,
  }))
}

function definitionOf(descriptor: FieldDescriptor | undefined): AttributeDefinition | undefined {
  return descriptor?.source.kind === 'attribute' ? descriptor.source.def : undefined
}

/** Record ids for every relation field the draft filled, by the name the model wrote. */
async function relationTargets(
  exec: Executor,
  draft: Draft,
  resolver: FieldResolver,
): Promise<readonly string[]> {
  const wanted = new Map<string, Set<string>>()
  for (const field of draft.fields) {
    const definition = definitionOf(resolver.get(field.slug))
    if (definition?.type !== 'relation') continue
    const target = relationTargetOf(definition)
    if (target === null) continue
    const bucket = wanted.get(target) ?? new Set<string>()
    bucket.add(field.value)
    wanted.set(target, bucket)
  }

  const ids: string[] = []
  for (const [objectType, names] of wanted) {
    const found = await findRecordsByLabel(exec, objectType as 'organization', [...names])
    for (const list of found.values()) ids.push(...list)
  }
  return ids
}

export function relationTargetOf(definition: AttributeDefinition): string | null {
  const config = definition.config as { targetObjectType?: unknown }
  return typeof config.targetObjectType === 'string' ? config.targetObjectType : null
}

/**
 * Organizations match **exactly** on the normalised name, never fuzzily (ADR-101).
 *
 * The asymmetry with contacts is deliberate and is argued in `write/organizations.ts`: the pairs a
 * fuzzy rule would join — "Kiln Robotics" and "Kiln Robotics GmbH" — are the ones a person would
 * keep apart, and a wrong merge silently relabels every contact linked to it.
 */
async function matchOrganization(exec: Executor, draft: Draft): Promise<readonly DuplicateMatch[]> {
  const found = await findRecordsByLabel(exec, 'organization', [draft.displayName])
  const ids = found.get(draft.displayName.trim()) ?? []
  return ids.map((recordId) => ({
    recordId,
    confidence: 1,
    band: 'certain' as const,
    rules: ['identifier' as const],
    evidence: `Same name: ${draft.displayName}`,
  }))
}

function buildInteraction(
  proposed: QuickCaptureOutput['interaction'],
  input: ProposeCaptureInput,
  dropped: string[],
): CapturedInteraction | null {
  if (proposed === null) return null
  const title = proposed.title.trim()
  if (title === '') return null

  const type = INTERACTION_TYPES.find((known) => known === proposed.type)
  if (type === undefined) {
    dropped.push(`interaction type "${proposed.type}"`)
    return null
  }

  const day = civilOr(proposed.occurredOn, input.today, dropped, 'interaction date')
  const body = proposed.body === null || proposed.body.trim() === '' ? null : proposed.body.trim()

  /**
   * Today gets the actual instant; any other day gets midday.
   *
   * Both halves matter. Midday rather than midnight, because the text says which *day* it happened
   * and midnight is the one instant that lands on the previous day in every timezone west of the
   * profile's. And *now* rather than midday for today, because a capture typed at 09:00 would
   * otherwise be filed three hours in the future — which reads as "last interaction: in 3 hours"
   * and is not what anybody meant by "met her this morning".
   */
  const occurredAt = day === input.today ? input.now : `${day}T12:00:00.000Z`
  return { type, title, body, occurredAt }
}

function buildFollowUp(
  proposed: QuickCaptureOutput['followUp'],
  input: ProposeCaptureInput,
  dropped: string[],
): CapturedFollowUp | null {
  if (proposed === null) return null
  const title = proposed.title.trim()
  if (title === '') return null

  const parsed = parseCivil(proposed.dueOn)
  if (!parsed.ok) {
    dropped.push(`follow-up date "${proposed.dueOn}"`)
    return null
  }

  return {
    title,
    dueAt: parsed.value,
    notes: proposed.notes === null || proposed.notes.trim() === '' ? null : proposed.notes.trim(),
  }
}

function civilOr(raw: string | null, fallback: string, dropped: string[], what: string): string {
  if (raw === null) return fallback
  const parsed = parseCivil(raw)
  if (parsed.ok) return parsed.value
  dropped.push(`${what} "${raw}"`)
  return fallback
}

/**
 * The model's leftovers, plus anything code refused.
 *
 * Both belong in the same place, because to the person reading the preview they are the same thing:
 * something in what they typed that did not become a row.
 */
function composeNote(modelNote: string | null, dropped: readonly string[]): string | null {
  const parts: string[] = []
  const note = modelNote?.trim() ?? ''
  if (note !== '') parts.push(note)
  const unique = [...new Set(dropped)].filter((entry) => entry !== '')
  if (unique.length > 0) parts.push(`Could not use: ${unique.join(', ')}.`)
  return parts.length === 0 ? null : parts.join(' ')
}
