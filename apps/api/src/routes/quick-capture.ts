/**
 * §4.8's quick capture, and §6.10's confirm.
 *
 * Two operations, and the split is the feature. `quickCapture` reads a sentence and **writes
 * nothing**: it returns a preview saying which records would be created and which already exist.
 * `commitQuickCapture` takes that preview back, as edited, and writes it — in one transaction, as
 * one operation, because confirming a capture is one user action however many rows it turns into
 * (§7). A client that had to call four create endpoints in order would be the "sequence of UI-only
 * calls" the MCP-adapter claim rests on not existing.
 *
 * This file is one of the paths ADR-071 allows to import the LLM module. The commit half does not
 * need it — nothing about writing a confirmed preview involves a model — but the two belong in one
 * file because they are two halves of one contract.
 */
import {
  CommitQuickCaptureResponseSchema,
  CommitQuickCaptureSchema,
  ProblemSchema,
  QuickCaptureRequestSchema,
  QuickCaptureResponseSchema,
  type CommitQuickCaptureResponse,
  type FieldResolver,
  type ObjectType,
  type QuickCaptureResponse,
} from '@mutuals/core'
import {
  createContact,
  createInteraction,
  createOrganization,
  applyValues,
  recomputeMetrics,
  type Executor,
} from '@mutuals/db'

import {
  loadSchema,
  loadSettings,
  workspaceId,
  type AppContext,
  type RequestSettings,
  type Schema,
} from '../context.ts'
import { llmUnavailable, validationFailed } from '../errors.ts'
import { created201 } from '../http/schema.ts'
import {
  proposeCapture,
  relationTargetOf,
  type CapturedRecord,
} from '../llm/tasks/quick-capture.ts'
import { planAttributeWrites } from '../write/attributes.ts'
import { routePlugin } from './shared.ts'

/** Every fact a capture writes says where it came from (§4.4). `quick_capture` is its own source. */
const CAPTURE_PROVENANCE = { source: 'quick_capture' } as const

const LLM_ERRORS = {
  400: ProblemSchema,
  429: ProblemSchema,
  500: ProblemSchema,
  502: ProblemSchema,
  503: ProblemSchema,
  504: ProblemSchema,
} as const

export const quickCaptureRoutes = routePlugin((app, ctx) => {
  app.post(
    '/quick-capture',
    {
      schema: {
        operationId: 'quickCapture',
        tags: ['agent'],
        summary:
          'Turn one sentence into a proposed contact, organization, interaction and follow-up. ' +
          'A preview: nothing is saved (§4.8).',
        body: QuickCaptureRequestSchema,
        response: { 200: QuickCaptureResponseSchema, ...LLM_ERRORS },
      },
    },
    async (request): Promise<QuickCaptureResponse> => {
      const llm = ctx.llm
      if (llm === undefined) throw llmUnavailable('AI features are not configured on this server.')

      const [settings, contactSchema, organizationSchema] = await Promise.all([
        loadSettings(ctx),
        loadSchema(ctx, 'contact'),
        loadSchema(ctx, 'organization'),
      ])

      const proposal = await proposeCapture(
        ctx.db,
        llm,
        {
          text: request.body.text,
          today: settings.today,
          now: ctx.now().toISOString(),
          timeZone: settings.timeZone,
          schemas: { contact: contactSchema.resolver, organization: organizationSchema.resolver },
          // The registry decides what a value may be, through the very same function an ordinary
          // create goes through — so the preview cannot promise a write that would then fail.
          validate: (objectType, values) => {
            const schema = objectType === 'contact' ? contactSchema : organizationSchema
            const planned = planAttributeWrites(values, schema, settings)
            return planned.ok ? [] : planned.issues
          },
        },
        {
          timeZone: settings.timeZone,
          requestId: request.id,
          workspaceId: await workspaceId(ctx),
        },
      )

      return {
        contact: toPreview(proposal.contact),
        organization: toPreview(proposal.organization),
        interaction: proposal.interaction,
        followUp: proposal.followUp,
        note: proposal.note,
      }
    },
  )

  app.post(
    '/quick-capture/commit',
    {
      schema: {
        operationId: 'commitQuickCapture',
        tags: ['agent'],
        summary:
          'Write a confirmed quick capture: the contact, the organization, the link between them, ' +
          'the interaction and the follow-up, in one transaction (§4.8, §6.10).',
        body: CommitQuickCaptureSchema,
        response: { ...created201(CommitQuickCaptureResponseSchema), 400: ProblemSchema },
      },
    },
    async (request, reply): Promise<CommitQuickCaptureResponse> => {
      const [settings, contactSchema, organizationSchema] = await Promise.all([
        loadSettings(ctx),
        loadSchema(ctx, 'contact'),
        loadSchema(ctx, 'organization'),
      ])

      const body = request.body
      if (
        body.contact == null &&
        body.organization == null &&
        body.interaction == null &&
        body.followUp == null
      ) {
        throw validationFailed([
          {
            code: 'required',
            path: [],
            message: 'There is nothing to save. Confirm at least one of the four.',
          },
        ])
      }
      // A follow-up hangs off a contact (§4.1), so one without a contact has nothing to hang from.
      if (body.followUp != null && body.contact == null) {
        throw validationFailed([
          {
            code: 'required',
            path: ['followUp'],
            message: 'A follow-up needs a contact. Keep the contact, or drop the follow-up.',
          },
        ])
      }

      const result = await ctx.db
        .transaction()
        .execute(async (trx) =>
          commit(trx, ctx, { contactSchema, organizationSchema, settings }, body),
        )

      /**
       * §4.7's derived columns, after the transaction and not inside it.
       *
       * A capture that logs a meeting has to move "last interaction" and warmth exactly as logging
       * one through the Activities tab does — `routes/interactions.ts` does the same thing for the
       * same reason (ADR-092). Found by running the flow and noticing the relationship card still
       * read "—" beside an interaction that was plainly there.
       *
       * Outside the transaction because the sweep reads what was written: inside, it would compute
       * from a snapshot that does not yet contain the row it is meant to be counting.
       */
      if (result.interactionId !== null) {
        await recomputeMetrics(ctx.db, {
          today: settings.today,
          timeZone: settings.timeZone,
          scope: {
            contactIds: result.contact === null ? [] : [result.contact.id],
            organizationIds: result.organization === null ? [] : [result.organization.id],
          },
        })
      }

      void reply.code(201)
      return result
    },
  )
})

function toPreview(record: CapturedRecord | null): QuickCaptureResponse['contact'] {
  if (record === null) return null
  const best = record.matches[0]
  return {
    // §6.10: the preview must make clear which records are new and which are matched. The default
    // follows the matcher's own verdict; the client can flip it, which is what `candidates` is for.
    action: best === undefined ? 'create' : 'match',
    matchId: best?.recordId ?? null,
    displayName: record.displayName,
    fields: record.fields.map((field) => ({
      slug: field.slug,
      label: field.label,
      value: field.value,
      confidence: field.confidence,
    })),
    candidates: record.matches.map((match) => ({
      id: match.recordId,
      displayName: match.displayName,
      confidence: match.confidence,
      band: match.band,
      evidence: match.evidence,
    })),
  }
}

interface CommitContext {
  readonly contactSchema: Schema
  readonly organizationSchema: Schema
  readonly settings: RequestSettings
}

/**
 * The whole write, in one transaction.
 *
 * The order is forced: the organization before the contact, because the contact's relation field
 * needs its id; the contact before the interaction and the follow-up, because both point at it.
 * A failure anywhere rolls the lot back, which is what "nothing is saved before confirmation"
 * has to mean on the write side as well as on the read side.
 */
async function commit(
  trx: Executor,
  ctx: AppContext,
  context: CommitContext,
  body: {
    contact?: {
      action: 'create' | 'match'
      matchId?: string | null
      fields: readonly { slug: string; value: string }[]
    } | null
    organization?: {
      action: 'create' | 'match'
      matchId?: string | null
      fields: readonly { slug: string; value: string }[]
    } | null
    interaction?: { type: string; title: string; body: string | null; occurredAt: string } | null
    followUp?: { title: string; dueAt: string; notes: string | null } | null
  },
): Promise<CommitQuickCaptureResponse> {
  const created: CommitQuickCaptureResponse['created'] = []

  let organizationId: string | null = null
  let organizationName = ''
  if (body.organization != null) {
    const split = splitFields(body.organization.fields, context.organizationSchema.resolver)
    organizationName = split.system['name'] ?? ''
    if (body.organization.action === 'match' && body.organization.matchId != null) {
      organizationId = body.organization.matchId
    } else {
      organizationId = await createOrganization(trx, {
        name: organizationName,
        createdVia: 'agent',
        provenance: CAPTURE_PROVENANCE,
      })
      created.push('organization')
    }
    await writeAttributes(
      trx,
      ctx,
      context.organizationSchema,
      context,
      organizationId,
      split.attributes,
    )
  }

  let contactId: string | null = null
  let contactName = ''
  let linked = false
  if (body.contact != null) {
    const split = splitFields(body.contact.fields, context.contactSchema.resolver)
    const attributes = { ...split.attributes }

    // The link, written through the ordinary relation attribute rather than through a concept
    // called "the contact's organization". Whichever relation field targets an organization is the
    // one; nothing here names a slug.
    const relationSlug = organizationRelationSlug(context.contactSchema.resolver)
    if (organizationId !== null && relationSlug !== null) {
      attributes[relationSlug] = [{ id: organizationId }]
      linked = true
    } else if (organizationId !== null && relationSlug === null) {
      // No relation field to hold it. The organization still lands; it is simply not linked.
      linked = false
    }

    if (body.contact.action === 'match' && body.contact.matchId != null) {
      contactId = body.contact.matchId
    } else {
      contactId = await createContact(trx, {
        firstName: split.system['first_name'] ?? '',
        lastName: split.system['last_name'] ?? '',
        createdVia: 'agent',
        provenance: CAPTURE_PROVENANCE,
      })
      created.push('contact')
    }
    contactName = [split.system['first_name'] ?? '', split.system['last_name'] ?? '']
      .filter((part) => part !== '')
      .join(' ')
    await writeAttributes(trx, ctx, context.contactSchema, context, contactId, attributes)
  }

  let interactionId: string | null = null
  if (body.interaction != null) {
    interactionId = await createInteraction(trx, {
      type: body.interaction.type as never,
      occurredAt: body.interaction.occurredAt,
      title: body.interaction.title,
      body: body.interaction.body,
      // §9 reserves the source enum for channel adapters; a capture is the agent's own.
      source: 'agent',
      createdVia: 'agent',
      contactIds: contactId === null ? [] : [contactId],
      organizationIds: organizationId === null ? [] : [organizationId],
      provenance: CAPTURE_PROVENANCE,
    })
    created.push('interaction')
  }

  let followUpId: string | null = null
  if (body.followUp != null && contactId !== null) {
    const row = await trx
      .insertInto('follow_up')
      .values({
        workspace_id: await workspaceId(ctx),
        contact_id: contactId,
        title: body.followUp.title,
        due_at: body.followUp.dueAt,
        status: 'Open',
        origin: 'manual',
        notes: body.followUp.notes,
      })
      .returning('id')
      .executeTakeFirstOrThrow()
    followUpId = row.id
    created.push('followUp')
  }

  return {
    contact:
      contactId === null
        ? null
        : { id: contactId, displayName: contactName, objectType: 'contact' as ObjectType },
    organization:
      organizationId === null
        ? null
        : {
            id: organizationId,
            displayName: organizationName,
            objectType: 'organization' as ObjectType,
          },
    interactionId,
    followUpId,
    created,
    linked,
  }
}

/**
 * The confirmed fields, split into the two things a create takes: system columns by name, and
 * user-defined attributes by slug.
 *
 * A repeatable attribute arriving twice collects into an array, the same way the preview built it.
 */
function splitFields(
  fields: readonly { slug: string; value: string }[],
  resolver: FieldResolver,
): { system: Record<string, string>; attributes: Record<string, unknown> } {
  // `system` is `string` rather than `unknown`: every writable system column a capture can fill is
  // text (`first_name`, `last_name`, `name`), and typing it so keeps `String(...)` off values that
  // would stringify as "[object Object]".
  const system: Record<string, string> = {}
  const attributes: Record<string, unknown> = {}

  for (const field of fields) {
    const descriptor = resolver.get(field.slug)
    if (descriptor === undefined || descriptor.readOnly) continue
    if (descriptor.source.kind !== 'attribute') {
      system[field.slug] = field.value
      continue
    }
    if (!descriptor.isMulti) {
      attributes[field.slug] = field.value
      continue
    }
    const existing = attributes[field.slug]
    const list: string[] = Array.isArray(existing) ? (existing as string[]) : []
    attributes[field.slug] = [...list, field.value]
  }

  return { system, attributes }
}

/** The relation field that points at an organization, or `null` when the workspace has none. */
function organizationRelationSlug(resolver: FieldResolver): string | null {
  for (const field of resolver.list()) {
    if (field.source.kind !== 'attribute' || field.source.def.type !== 'relation') continue
    if (relationTargetOf(field.source.def) === 'organization') return field.slug
  }
  return null
}

async function writeAttributes(
  trx: Executor,
  ctx: AppContext,
  schema: Schema,
  context: CommitContext,
  recordId: string,
  attributes: Record<string, unknown>,
): Promise<void> {
  if (Object.keys(attributes).length === 0) return
  const planned = planAttributeWrites(attributes, schema, context.settings)
  if (!planned.ok) throw validationFailed(planned.issues)
  await applyValues(trx, { recordId, changes: planned.value, provenance: CAPTURE_PROVENANCE })
  void ctx
}
