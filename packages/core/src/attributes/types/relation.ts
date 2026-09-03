/**
 * `relation` — a link to another record, optionally carrying the link metadata §4.3 needs to make
 * a contact's work history readable ("Co-Founder, Jun 2023 – now, primary").
 *
 * The only type whose cardinality comes from its config, the only one that never sorts, and the
 * only one whose values are projected into `record_link` instead of `attribute_value` — because
 * the link is itself a thing with attributes, and a value row has nowhere to put them.
 */
import { z } from 'zod'

import { fail, failWith, ok, type CoreIssue, type Result } from '../../result.ts'
import {
  OBJECT_TYPES,
  VALUE_KIND_BY_ATTRIBUTE_TYPE,
  type LinkMetadata,
  type SlotValue,
} from '../kinds.ts'
import { splitMultiValue, type AttributeTypeDefinition } from './def.ts'
import { civilDateSchema } from './date.ts'

const configSchema = z.object({
  targetObjectType: z.enum(OBJECT_TYPES),
  cardinality: z.enum(['one', 'many']),
  /** §4.3: only the contact↔organization link asks for title / from / to / primary. */
  hasLinkMetadata: z.boolean().default(false),
})

export type RelationConfig = z.output<typeof configSchema>

const relationRefSchema = z.object({
  id: z.uuid(),
  title: z.string().trim().min(1).max(120).optional(),
  from: civilDateSchema.optional(),
  to: civilDateSchema.nullable().optional(),
  isPrimary: z.boolean().optional(),
})

export type RelationRef = z.output<typeof relationRefSchema>

export const relation = {
  type: 'relation',
  valueKind: VALUE_KIND_BY_ATTRIBUTE_TYPE.relation,
  cardinality: 'from-config',
  ui: 'record_picker',
  configSchema,

  value(config: unknown): z.ZodType {
    const parsed = configSchema.parse(config)
    const list = z.array(relationRefSchema).min(1)
    return parsed.cardinality === 'one' ? list.max(1) : list
  },

  normalize(input: unknown, config: unknown): readonly SlotValue[] {
    const parsed = configSchema.parse(config)
    const refs = z.array(relationRefSchema).parse(input)
    if (parsed.cardinality === 'one' && refs.length > 1) {
      throw new Error('relation.normalize received several targets for a one-to-one relation')
    }
    const seen = new Set<string>()
    const slots: SlotValue[] = []
    for (const ref of refs) {
      if (seen.has(ref.id)) continue
      seen.add(ref.id)
      const link = linkOf(ref, parsed)
      slots.push(
        link === undefined
          ? { kind: 'relation', targetRecordId: ref.id }
          : { kind: 'relation', targetRecordId: ref.id, link },
      )
    }
    return slots
  },

  /**
   * A cell only ever holds record ids here. Turning "Northstar Ventures" into an id is a lookup
   * against existing records with a duplicate-style confidence, which is the import wizard's job
   * (§6.8) and not a pure function's.
   */
  coerce(raw: string, config: unknown): Result<RelationRef[]> {
    const parsed = configSchema.parse(config)
    const parts = splitMultiValue(raw)
    if (parts.length === 0) return fail('required', 'This field is empty.')
    const issues: CoreIssue[] = []
    const refs: RelationRef[] = []
    parts.forEach((part, index) => {
      const id = z.uuid().safeParse(part)
      if (!id.success) {
        issues.push({
          code: 'invalid_input',
          path: [index],
          message: `"${part}" is not a record id. Pick the record instead of typing its name.`,
        })
        return
      }
      if (!refs.some((ref) => ref.id === id.data)) refs.push({ id: id.data })
    })
    if (parsed.cardinality === 'one' && refs.length > 1) {
      issues.push({
        code: 'invalid_input',
        path: [],
        message: 'This attribute links to one record only.',
      })
    }
    return issues.length > 0 ? failWith(issues) : ok(refs)
  },

  /** Ids, not names: the display label is joined in on the read path from `record.display_label`. */
  format(values: readonly SlotValue[]): string {
    return values
      .flatMap((value) => (value.kind === 'relation' ? [value.targetRecordId] : []))
      .join(', ')
  },

  operators: ['has_any_of', 'is_empty', 'is_not_empty'],
  sort: null,
  hasValueMapping: false,
} as const satisfies AttributeTypeDefinition

function linkOf(ref: RelationRef, config: RelationConfig): LinkMetadata | undefined {
  if (!config.hasLinkMetadata) return undefined
  const link = {
    ...(ref.title === undefined ? {} : { title: ref.title }),
    ...(ref.from === undefined ? {} : { from: ref.from }),
    ...(ref.to === undefined ? {} : { to: ref.to }),
    ...(ref.isPrimary === undefined ? {} : { isPrimary: ref.isPrimary }),
  }
  return Object.keys(link).length === 0 ? undefined : link
}
