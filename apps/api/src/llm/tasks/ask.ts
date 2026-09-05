/**
 * §4.8's "ask the network", the half that decides.
 *
 * The model proposes; this file disposes. Everything it returns is a string the user could have
 * typed — a slug, an operator name, an option key, a company name — and every one of them is
 * checked here against the resolver built from the workspace's own attribute definitions before a
 * single character of SQL exists. Nothing reaches the query compiler that `packages/core` has not
 * validated, which is why an "unknown field" from the model is a sentence in the answer rather than
 * a 500 (§4.8, ADR-071).
 *
 * Two loops, and they are different on purpose. A *schema* failure — the answer is not the shape it
 * was asked for — is repaired inside `LlmClient` and, twice failed, is a 502: the provider is not
 * honouring its own contract. A *domain* failure — a slug that is not a field, an operator the
 * field does not offer — is repaired here by asking again with the complaints attached, and, twice
 * failed, is a 200 whose answer says plainly that the question could not be expressed. They are
 * different because the user's next move is different: one is "try again", the other is "ask me
 * something else".
 */
import {
  OPERATOR_SHAPE_BY_ID,
  activeOptions,
  RELATIVE_PRESETS,
  RELATIVE_UNITS,
  fieldValueKind,
  findOptionByKey,
  isOperatorId,
  parseFilterSet,
  type FieldDescriptor,
  type FieldResolver,
  type Filter,
  type FilterSet,
  type ObjectType,
} from '@mutuals/core'
import { findRecordsByLabel, type Executor } from '@mutuals/db'

import type { LlmClient, RunOptions } from '../client.ts'
import {
  askFilterPrompt,
  type AskFilterInput,
  type AskFilterOutput,
  type ProposedFilter,
  type PromptField,
} from '../prompts/ask-filter.ts'

export type AskObjectType = 'contact' | 'organization'

export interface AskSchemaInput {
  readonly objectType: AskObjectType
  readonly resolver: FieldResolver
}

export interface ProposeFilterInput {
  readonly question: string
  readonly today: string
  readonly timeZone: string
  /** One entry when the caller pinned an object type, two when the model may choose. */
  readonly schemas: readonly AskSchemaInput[]
}

export interface ProposedQuery {
  readonly objectType: AskObjectType
  /** `null` when the question did not become a filter; `answer` then says why. */
  readonly filter: FilterSet | null
  /** The noun phrase the model gave, for the sentence the caller composes. */
  readonly subject: string
  /** Set when nothing ran. Already a plain sentence, ready to show. */
  readonly declineReason: string | null
  readonly callIds: readonly string[]
  readonly model: string
}

/**
 * A field as the model is told about it.
 *
 * Read straight off the resolver, so a field the user created five minutes ago is in the prompt
 * and a field they deleted is not. This is the whole of "the LLM receives the schema" in §4.8, and
 * it is also why nothing here can name a field: the list is data.
 */
export function promptFieldsFor(resolver: FieldResolver): readonly PromptField[] {
  return resolver.list().map((field) => ({
    slug: field.slug,
    label: field.label,
    type: field.source.kind === 'attribute' ? field.source.def.type : fieldValueKind(field),
    operators: [...field.operators],
    options:
      field.source.kind === 'attribute'
        ? activeOptions(field.source.def.options ?? []).map((option) => ({
            key: option.key,
            label: option.label,
          }))
        : [],
    isMulti: field.isMulti,
    relationTarget: relationTargetOf(field),
  }))
}

/**
 * What a relation field points at, in `packages/core`'s spelling.
 *
 * `targetObjectType`, not `target_object_type`. Migration 0002 stores the snake_case form and
 * `repositories/attributes.ts` normalises it on the way out, so by the time a definition reaches
 * here there is exactly one spelling — and reading the stored one would return `null` for every
 * relation field, silently: the model would never be told what a name could name, and every
 * relation filter would fail to resolve with no error anywhere. Found by a unit test, which is why
 * the test names the field explicitly.
 */
function relationTargetOf(field: FieldDescriptor): string | null {
  if (field.source.kind !== 'attribute' || field.source.def.type !== 'relation') return null
  const config = field.source.def.config as { targetObjectType?: unknown }
  return typeof config.targetObjectType === 'string' ? config.targetObjectType : null
}

/**
 * One question, one validated filter — with at most one domain repair.
 *
 * The repair costs a second billable request, which the cap is checked against separately before
 * each POST (ADR-070). One is worth it: "you used a field that does not exist, here is the list
 * again" is the single most common failure and the one a model fixes reliably when told.
 */
export async function proposeQuery(
  exec: Executor,
  llm: LlmClient,
  input: ProposeFilterInput,
  options: RunOptions,
): Promise<ProposedQuery> {
  const tables = input.schemas.map((schema) => ({
    objectType: schema.objectType,
    fields: [...promptFieldsFor(schema.resolver)],
  }))

  const callIds: string[] = []
  let problems: readonly string[] = []
  let model = ''

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const promptInput: AskFilterInput = {
      question: input.question,
      today: input.today,
      timeZone: input.timeZone,
      tables,
      problems: [...problems],
    }

    const run = await llm.run(exec, askFilterPrompt, promptInput, options)
    model = run.model
    if (run.callId !== null) callIds.push(run.callId)

    const chosen = chooseObjectType(run.value, input.schemas)
    if (!run.value.understood) {
      return {
        objectType: chosen.objectType,
        filter: null,
        subject: run.value.subject,
        declineReason: declineSentence(run.value),
        callIds,
        model,
      }
    }

    // One round trip per target type rather than one per filter — the same reasoning as ADR-042's
    // batched identifier probes, at a much smaller scale, and it keeps "who works at A or B" one
    // query.
    const relationIds = await resolveRelationNames(exec, chosen.resolver, run.value.filters)
    const built = buildFilterSet(chosen.resolver, run.value.filters, relationIds)
    if (built.ok) {
      return {
        objectType: chosen.objectType,
        filter: built.filter,
        subject: run.value.subject,
        declineReason: null,
        callIds,
        model,
      }
    }

    problems = built.problems
  }

  return {
    objectType: input.schemas[0]?.objectType ?? 'contact',
    filter: null,
    subject: '',
    declineReason:
      'I could not turn that into a search over your fields. Try naming a field, for example ' +
      '"contacts in Berlin" or "people I have not spoken to in six months".',
    callIds,
    model,
  }
}

function declineSentence(output: AskFilterOutput): string {
  const reason = output.declineReason?.trim() ?? ''
  return reason === '' ? 'I could not answer that from your network.' : reason
}

/** The model's choice, narrowed to a table the caller actually offered. */
function chooseObjectType(
  output: AskFilterOutput,
  schemas: readonly AskSchemaInput[],
): AskSchemaInput {
  const first = schemas[0]
  if (first === undefined) throw new Error('proposeQuery needs at least one schema')
  return schemas.find((schema) => schema.objectType === output.objectType) ?? first
}

type BuildResult =
  | { readonly ok: true; readonly filter: FilterSet }
  | { readonly ok: false; readonly problems: readonly string[] }

/**
 * Flat proposals → the filter model, or a list of complaints written for the model to fix.
 *
 * Pure, and it takes the resolved relation ids rather than fetching them, so every branch of the
 * validation — every operator shape, every value kind, every complaint — is a unit test with no
 * database. The one thing that genuinely needs Postgres, turning a company name into ids, is
 * {@link resolveRelationNames} and is tested against Postgres.
 *
 * Every complaint names the field and says what was allowed, because the repair message is the
 * only information the second attempt gets.
 */
export function buildFilterSet(
  resolver: FieldResolver,
  proposals: readonly ProposedFilter[],
  relationIds: ReadonlyMap<string, readonly string[]> = new Map(),
): BuildResult {
  const problems: string[] = []
  const draft: unknown[] = []

  for (const proposal of proposals) {
    const field = resolver.get(proposal.field)
    if (field === undefined) {
      problems.push(
        `"${proposal.field}" is not a field. Use one of the slugs listed for this table.`,
      )
      continue
    }

    if (!isOperatorId(proposal.op)) {
      problems.push(`"${proposal.op}" is not an operator.`)
      continue
    }
    if (!field.operators.includes(proposal.op)) {
      problems.push(
        `"${field.slug}" does not offer "${proposal.op}". It offers: ${field.operators.join(', ')}.`,
      )
      continue
    }

    const payload = payloadFor(field, proposal, relationIds, problems)
    if (payload === null) continue
    draft.push({ field: field.slug, op: proposal.op, ...payload })
  }

  if (problems.length > 0) return { ok: false, problems }

  // The last word belongs to core's own parser: shape, arity, value length and the filter count
  // are its rules, not this file's, and a second transcription of them here is a second place to
  // get them wrong.
  const parsed = parseFilterSet(draft)
  if (!parsed.ok) {
    return { ok: false, problems: parsed.issues.map((issue) => issue.message) }
  }
  return { ok: true, filter: parsed.value }
}

type Payload = Record<string, unknown>

function payloadFor(
  field: FieldDescriptor,
  proposal: ProposedFilter,
  relationIds: ReadonlyMap<string, readonly string[]>,
  problems: string[],
): Payload | null {
  const shape = OPERATOR_SHAPE_BY_ID[proposal.op as keyof typeof OPERATOR_SHAPE_BY_ID]

  switch (shape) {
    case 'none':
      return {}

    case 'value': {
      const value = coerceOne(field, proposal.value, relationIds, problems)
      return value === null ? null : { value }
    }

    case 'range': {
      if (proposal.from === null || proposal.to === null) {
        problems.push(`"${proposal.op}" on "${field.slug}" needs both from and to.`)
        return null
      }
      return { from: proposal.from, to: proposal.to }
    }

    case 'values': {
      const raw = proposal.values ?? []
      if (raw.length === 0) {
        problems.push(`"${proposal.op}" on "${field.slug}" needs at least one value.`)
        return null
      }
      const before = problems.length
      const values = raw.flatMap((one) => coerceMany(field, one, relationIds, problems))
      if (problems.length > before) return null
      if (values.length === 0) return null
      return { values }
    }

    case 'preset': {
      const preset = proposal.preset
      if (preset === null || !RELATIVE_PRESETS.includes(preset as never)) {
        problems.push(
          `"${String(preset)}" is not a relative preset. Use one of: ${RELATIVE_PRESETS.join(', ')}.`,
        )
        return null
      }
      return { preset }
    }

    case 'duration': {
      const unit = proposal.unit
      if (proposal.n === null || !Number.isInteger(proposal.n) || proposal.n < 0) {
        problems.push(`"${proposal.op}" on "${field.slug}" needs a whole number of units.`)
        return null
      }
      if (unit === null || !RELATIVE_UNITS.includes(unit as never)) {
        problems.push(`"${String(unit)}" is not a unit. Use one of: ${RELATIVE_UNITS.join(', ')}.`)
        return null
      }
      return { n: proposal.n, unit }
    }

    default:
      return null
  }
}

/** One value for a one-operand operator; `null` means a complaint was recorded. */
function coerceOne(
  field: FieldDescriptor,
  raw: string | null,
  relationIds: ReadonlyMap<string, readonly string[]>,
  problems: string[],
): string | null {
  if (raw === null) {
    problems.push(`"${field.slug}" needs a value for this operator.`)
    return null
  }
  const values = coerceMany(field, raw, relationIds, problems)
  return values[0] ?? null
}

/**
 * One proposed value → zero or more wire values.
 *
 * Zero happens for a relation name that matches no record, and one name can become several ids
 * when two records genuinely share a label (§6.9's merge is the fix for that, not this function's
 * problem). An option label the model wrote instead of a key is corrected here rather than
 * complained about: it is the model doing the obvious thing with a human-readable list, and one
 * lookup is cheaper than a repair round-trip.
 */
function coerceMany(
  field: FieldDescriptor,
  raw: string,
  relationIds: ReadonlyMap<string, readonly string[]>,
  problems: string[],
): readonly string[] {
  const kind = fieldValueKind(field)

  if (kind === 'relation') {
    const ids = relationIds.get(raw.trim()) ?? []
    if (ids.length === 0) {
      problems.push(`There is no record called "${raw}" to match "${field.slug}" against.`)
      return []
    }
    return ids
  }

  if (kind === 'option' && field.source.kind === 'attribute') {
    const options = field.source.def.options ?? []
    // Matching accepts an archived key — a filter may legitimately ask for an option that has since
    // been retired, exactly as a saved view holding one still renders (§4.2, `sentence.ts`).
    if (findOptionByKey(options, raw) !== undefined) return [raw]
    const byLabel = options.find(
      (option) => option.label.toLocaleLowerCase() === raw.trim().toLocaleLowerCase(),
    )
    if (byLabel !== undefined) return [byLabel.key]
    // The *suggestion* lists only live options, because offering a retired one as the fix would
    // send the repair round-trip at a value the user can no longer set in the UI.
    problems.push(
      `"${raw}" is not an option of "${field.slug}". Use one of the keys: ` +
        `${activeOptions(options)
          .map((option) => option.key)
          .join(', ')}.`,
    )
    return []
  }

  return [raw]
}

/**
 * Every relation name the proposal mentions, mapped to record ids.
 *
 * The model is told to give a name because it has no way to know an id, and this is where the name
 * becomes a record — or does not. §4.8's rule reads as one line of code here: the model produced
 * `"Northstar Ventures"`, and the database decided whether that is a record.
 */
export async function resolveRelationNames(
  exec: Executor,
  resolver: FieldResolver,
  proposals: readonly ProposedFilter[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  const wanted = new Map<ObjectType, Set<string>>()

  for (const proposal of proposals) {
    const field = resolver.get(proposal.field)
    if (field === undefined || fieldValueKind(field) !== 'relation') continue
    const target = relationTargetOf(field)
    if (target === null) continue
    const names = [proposal.value, ...(proposal.values ?? [])].filter(
      (name): name is string => typeof name === 'string' && name.trim() !== '',
    )
    if (names.length === 0) continue
    const bucket = wanted.get(target as ObjectType) ?? new Set<string>()
    for (const name of names) bucket.add(name.trim())
    wanted.set(target as ObjectType, bucket)
  }

  const resolved = new Map<string, readonly string[]>()
  for (const [objectType, names] of wanted) {
    const found = await findRecordsByLabel(exec, objectType, [...names])
    for (const [name, ids] of found) resolved.set(name, ids)
  }
  return resolved
}

/**
 * The sentence the user reads.
 *
 * Composed here, around the real row count, because the model is never asked for a number. A model
 * that writes "I found 12 contacts" before the query has run will occasionally write 12 when the
 * answer is 340, and nothing downstream can tell which it did (ADR-103).
 */
export function composeAnswer(
  query: Pick<ProposedQuery, 'objectType' | 'filter' | 'subject' | 'declineReason'>,
  total: number,
): string {
  if (query.declineReason !== null) return query.declineReason

  const noun = query.objectType === 'contact' ? 'contact' : 'organization'
  const plural = total === 1 ? noun : `${noun}s`
  const subject = query.subject.trim().replace(/\.$/, '')
  const tail = subject === '' ? '' : ` matching ${subject}`

  if (total === 0) return `No ${noun}s${tail}.`
  return `Found ${total.toLocaleString('en-GB')} ${plural}${tail}.`
}

/** The filter set as the list endpoint's `?filter=` parameter, for the link under the answer. */
export function filterQueryString(filter: FilterSet): string {
  return JSON.stringify(filter satisfies readonly Filter[])
}
