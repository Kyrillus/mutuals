/**
 * The endpoints behind a record list, as data.
 *
 * Contacts and Organizations differ by a path and a response schema and by nothing else, so the
 * table, the create dialog and the mutations are all written against this table rather than
 * against either object type. Interactions and follow-ups are deliberately absent: their wire
 * shapes carry no `attributes` map and no display label, so they arrive with an adapter of their
 * own when §6.4 is built rather than by loosening this one.
 */
import {
  BulkResultSchema,
  ContactSchema,
  CreateContactSchema,
  CreateOrganizationSchema,
  ListMetaSchema,
  OrganizationSchema,
  PageSchema,
  listResponseSchema,
} from '@mutuals/core'
import { z } from 'zod'

import type { RecordRow } from '@/table/record-row.ts'

export const RECORD_OBJECT_TYPES = ['contact', 'organization'] as const

export type RecordObjectType = (typeof RECORD_OBJECT_TYPES)[number]

/**
 * The page shape the table consumes. The per-object-type schemas below parse into something
 * *narrower* than this — a `Contact` is a `RecordRow` with more on it — which is exactly the
 * direction that keeps validation strict while the consumer stays generic.
 */
export const RecordListSchema = z.object({
  data: z.array(z.custom<RecordRow>()),
  page: PageSchema,
  meta: ListMetaSchema,
})

export type RecordListPage = z.output<typeof RecordListSchema>

export interface RecordEndpoint {
  readonly objectType: RecordObjectType
  readonly path: string
  /** Singular, lower case: the word the bulk bar and the empty state put in a sentence. */
  readonly noun: string
  readonly list: z.ZodType<RecordListPage>
  readonly one: z.ZodType<RecordRow>
  readonly create: z.ZodType
}

const ENDPOINTS: Record<RecordObjectType, RecordEndpoint> = {
  contact: {
    objectType: 'contact',
    path: '/contacts',
    noun: 'contact',
    list: listResponseSchema(ContactSchema),
    one: ContactSchema,
    create: CreateContactSchema,
  },
  organization: {
    objectType: 'organization',
    path: '/organizations',
    noun: 'organization',
    list: listResponseSchema(OrganizationSchema),
    one: OrganizationSchema,
    create: CreateOrganizationSchema,
  },
}

export function recordEndpoint(objectType: RecordObjectType): RecordEndpoint {
  return ENDPOINTS[objectType]
}

export { BulkResultSchema }
