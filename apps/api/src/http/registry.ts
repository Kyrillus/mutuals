/**
 * Names the shared schemas so the OpenAPI document references them instead of inlining them.
 *
 * Without this every route repeats the whole of `Contact` — attributes union and all — three or
 * four times, and `docs/openapi.json` is half a megabyte of duplicated JSON that no human can
 * review in a diff. With it the document is components plus `$ref`s, which is also what a
 * generated Python client or an MCP tool definition wants.
 *
 * Registration happens here rather than in `packages/core` on purpose: naming a schema for a
 * document is the API's concern, and `@mutuals/core` stays free of import side effects for the
 * browser bundle.
 *
 * ADR-029's correction applies: `fastify-type-provider-zod@7` emits **two** components per
 * registered schema — `X` for the response (output) side and `XInput` for the request side — so
 * seeing both in the document is expected, not a duplication bug.
 */
import {
  AttributeDefinitionSchema,
  AttributeOptionSchema,
  AttributeValueSchema,
  AttributesSchema,
  BulkResultSchema,
  ConnectionsSchema,
  ContactSchema,
  FollowUpSchema,
  InteractionSchema,
  ListMetaSchema,
  OptionRefSchema,
  OrganizationSchema,
  PageSchema,
  ProblemErrorSchema,
  ProblemSchema,
  ProfileSchema,
  ProvenanceSchema,
  RecordRefSchema,
  RelationValueSchema,
  StatsSchema,
} from '@mutuals/core'
import { z } from 'zod'

const NAMED = {
  Problem: ProblemSchema,
  ProblemError: ProblemErrorSchema,
  Page: PageSchema,
  ListMeta: ListMetaSchema,
  BulkResult: BulkResultSchema,
  RecordRef: RecordRefSchema,
  Provenance: ProvenanceSchema,
  OptionRef: OptionRefSchema,
  RelationValue: RelationValueSchema,
  AttributeValue: AttributeValueSchema,
  Attributes: AttributesSchema,
  AttributeOption: AttributeOptionSchema,
  AttributeDefinition: AttributeDefinitionSchema,
  Contact: ContactSchema,
  Organization: OrganizationSchema,
  Interaction: InteractionSchema,
  FollowUp: FollowUpSchema,
  Connections: ConnectionsSchema,
  Profile: ProfileSchema,
  Stats: StatsSchema,
} as const

/** Idempotent: `buildApp` may be called many times in one process, and a test suite does. */
export function registerOpenApiSchemas(): void {
  for (const [id, schema] of Object.entries(NAMED)) {
    if (z.globalRegistry.get(schema)?.id === id) continue
    z.globalRegistry.add(schema, { id })
  }
}

export const OPENAPI_SCHEMA_NAMES: readonly string[] = Object.freeze(Object.keys(NAMED))
