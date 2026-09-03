/**
 * System columns and derived columns, declared as data.
 *
 * §5.2 requires the computed columns — `last_interaction_at`, `interaction_count_12m`,
 * `open_followups`, `warmth`, `people_count` — to appear in the Columns picker and the filter
 * picker "like any other attribute". Declaring them here, beside the real columns, is what makes
 * that true without a single `if (slug === 'warmth')` anywhere in the table or the compiler.
 *
 * Every `column` value is a literal in this frozen list, so no user-supplied string can ever
 * become a SQL identifier; and `reserved.ts` derives its first tier of reserved slugs from this
 * array, so adding a field here reserves its name in the same commit.
 */
import type { ValueKind } from '../attributes/kinds.ts'
import type { OperatorId } from '../attributes/operators.ts'
import type { ObjectType } from '../attributes/kinds.ts'

export type SystemTable = 'record' | 'contact' | 'organization' | 'interaction'
export type MetricTable = 'contact_metrics' | 'organization_metrics'

const TEXT_OPERATORS = ['contains', 'equals', 'is_empty', 'is_not_empty'] as const
const ENUM_OPERATORS = ['equals', 'is_one_of', 'is_not_one_of'] as const
const NUMBER_OPERATORS = ['eq', 'neq', 'lt', 'gt', 'between'] as const
const TIMESTAMP_OPERATORS = [
  'before',
  'after',
  'between',
  'in_relative',
  'older_than',
  'newer_than',
] as const
const NULLABLE_TIMESTAMP_OPERATORS = [...TIMESTAMP_OPERATORS, 'is_empty', 'is_not_empty'] as const
const BOOLEAN_OPERATORS = ['is_yes', 'is_no'] as const

/** §6.5 sidebar sections. Fields without one fall under "Details", like ungrouped attributes. */
export const PROVENANCE_GROUP = 'Provenance'
export const RELATIONSHIP_GROUP = 'Relationship'

const PROVENANCE_FIELDS = [
  {
    slug: 'created_at',
    label: 'Created',
    table: 'record',
    column: 'created_at',
    valueKind: 'date',
    operators: TIMESTAMP_OPERATORS,
    sortable: true,
    derived: false,
    readOnly: true,
    showByDefault: true,
    group: PROVENANCE_GROUP,
  },
  {
    slug: 'updated_at',
    label: 'Updated',
    table: 'record',
    column: 'updated_at',
    valueKind: 'date',
    operators: TIMESTAMP_OPERATORS,
    sortable: true,
    derived: false,
    readOnly: true,
    showByDefault: false,
    group: PROVENANCE_GROUP,
  },
  {
    slug: 'created_via',
    label: 'Created via',
    table: 'record',
    column: 'created_via',
    valueKind: 'text',
    operators: ENUM_OPERATORS,
    sortable: false,
    derived: false,
    readOnly: true,
    showByDefault: false,
    group: PROVENANCE_GROUP,
  },
  {
    // §6.8's result screen links to "everything that came out of this file".
    slug: 'import_batch_id',
    label: 'Import',
    table: 'record',
    column: 'import_batch_id',
    valueKind: 'text',
    operators: ['equals', 'is_empty', 'is_not_empty'],
    sortable: false,
    derived: false,
    readOnly: true,
    showByDefault: false,
    group: PROVENANCE_GROUP,
  },
] as const

export const SYSTEM_FIELDS = {
  contact: [
    {
      slug: 'display_name',
      label: 'Name',
      table: 'contact',
      column: 'display_name',
      valueKind: 'text',
      operators: TEXT_OPERATORS,
      sortable: true,
      derived: false,
      // Generated from first and last name in the database; editing it means editing those.
      readOnly: true,
      showByDefault: true,
    },
    {
      slug: 'first_name',
      label: 'First name',
      table: 'contact',
      column: 'first_name',
      valueKind: 'text',
      operators: TEXT_OPERATORS,
      sortable: true,
      derived: false,
      readOnly: false,
      showByDefault: false,
    },
    {
      slug: 'last_name',
      label: 'Last name',
      table: 'contact',
      column: 'last_name',
      valueKind: 'text',
      operators: TEXT_OPERATORS,
      sortable: true,
      derived: false,
      readOnly: false,
      showByDefault: false,
    },
    ...PROVENANCE_FIELDS,
    {
      slug: 'warmth',
      label: 'Warmth',
      table: 'contact_metrics',
      column: 'warmth',
      valueKind: 'number',
      operators: NUMBER_OPERATORS,
      sortable: true,
      derived: true,
      readOnly: true,
      showByDefault: false,
      group: RELATIONSHIP_GROUP,
    },
    {
      slug: 'last_interaction_at',
      label: 'Last interaction',
      table: 'contact_metrics',
      column: 'last_interaction_at',
      valueKind: 'date',
      operators: NULLABLE_TIMESTAMP_OPERATORS,
      sortable: true,
      derived: true,
      readOnly: true,
      showByDefault: true,
      group: RELATIONSHIP_GROUP,
    },
    {
      slug: 'interaction_count_12m',
      label: 'Interactions (12m)',
      table: 'contact_metrics',
      column: 'interaction_count_12m',
      valueKind: 'number',
      operators: NUMBER_OPERATORS,
      sortable: true,
      derived: true,
      readOnly: true,
      showByDefault: false,
      group: RELATIONSHIP_GROUP,
    },
    {
      slug: 'open_followups',
      label: 'Open follow-ups',
      table: 'contact_metrics',
      column: 'open_followups',
      valueKind: 'number',
      operators: NUMBER_OPERATORS,
      sortable: true,
      derived: true,
      readOnly: true,
      showByDefault: false,
      group: RELATIONSHIP_GROUP,
    },
    {
      slug: 'next_followup_at',
      label: 'Next follow-up',
      table: 'contact_metrics',
      column: 'next_followup_at',
      valueKind: 'date',
      operators: NULLABLE_TIMESTAMP_OPERATORS,
      sortable: true,
      derived: true,
      readOnly: true,
      showByDefault: false,
      group: RELATIONSHIP_GROUP,
    },
    {
      // §4.7's manual overrides are behaviour, not data, so they are columns rather than attributes.
      slug: 'pinned_important',
      label: 'Pinned as important',
      table: 'contact',
      column: 'pinned_important',
      valueKind: 'bool',
      operators: BOOLEAN_OPERATORS,
      sortable: false,
      derived: false,
      readOnly: false,
      showByDefault: false,
      group: RELATIONSHIP_GROUP,
    },
    {
      slug: 'not_important',
      label: 'Not important',
      table: 'contact',
      column: 'not_important',
      valueKind: 'bool',
      operators: BOOLEAN_OPERATORS,
      sortable: false,
      derived: false,
      readOnly: false,
      showByDefault: false,
      group: RELATIONSHIP_GROUP,
    },
  ],

  organization: [
    {
      slug: 'name',
      label: 'Name',
      table: 'organization',
      column: 'name',
      valueKind: 'text',
      operators: TEXT_OPERATORS,
      sortable: true,
      derived: false,
      readOnly: false,
      showByDefault: true,
    },
    ...PROVENANCE_FIELDS,
    {
      slug: 'people_count',
      label: 'People',
      table: 'organization_metrics',
      column: 'people_count',
      valueKind: 'number',
      operators: NUMBER_OPERATORS,
      sortable: true,
      derived: true,
      readOnly: true,
      showByDefault: true,
      group: RELATIONSHIP_GROUP,
    },
    {
      slug: 'last_interaction_at',
      label: 'Last interaction',
      table: 'organization_metrics',
      column: 'last_interaction_at',
      valueKind: 'date',
      operators: NULLABLE_TIMESTAMP_OPERATORS,
      sortable: true,
      derived: true,
      readOnly: true,
      showByDefault: false,
      group: RELATIONSHIP_GROUP,
    },
  ],

  interaction: [
    {
      slug: 'type',
      label: 'Type',
      table: 'interaction',
      column: 'type',
      valueKind: 'text',
      operators: ENUM_OPERATORS,
      sortable: true,
      derived: false,
      readOnly: false,
      showByDefault: true,
    },
    {
      slug: 'title',
      label: 'Title',
      table: 'interaction',
      column: 'title',
      valueKind: 'text',
      operators: TEXT_OPERATORS,
      sortable: true,
      derived: false,
      readOnly: false,
      showByDefault: true,
    },
    {
      slug: 'occurred_at',
      label: 'Date',
      table: 'interaction',
      column: 'occurred_at',
      valueKind: 'date',
      operators: TIMESTAMP_OPERATORS,
      sortable: true,
      derived: false,
      readOnly: false,
      showByDefault: true,
    },
    {
      slug: 'body',
      label: 'Notes',
      table: 'interaction',
      column: 'body',
      valueKind: 'text',
      operators: ['contains', 'is_empty', 'is_not_empty'],
      sortable: false,
      derived: false,
      readOnly: false,
      showByDefault: false,
    },
    {
      slug: 'source',
      label: 'Source',
      table: 'interaction',
      column: 'source',
      valueKind: 'text',
      operators: ENUM_OPERATORS,
      sortable: false,
      derived: false,
      readOnly: true,
      showByDefault: false,
    },
    ...PROVENANCE_FIELDS,
  ],
} as const satisfies Record<ObjectType, readonly SystemFieldShape[]>

interface SystemFieldShape {
  readonly slug: string
  readonly label: string
  readonly table: SystemTable | MetricTable
  readonly column: string
  readonly valueKind: ValueKind
  readonly operators: readonly OperatorId[]
  readonly sortable: boolean
  readonly derived: boolean
  readonly readOnly: boolean
  readonly showByDefault: boolean
  readonly group?: string
}

export type SystemField = (typeof SYSTEM_FIELDS)[ObjectType][number]

/** Closed unions, so the compiler can prove every emitted identifier came from this file. */
export type SystemColumn = Extract<SystemField, { readonly table: SystemTable }>['column']
export type MetricColumn = Extract<SystemField, { readonly table: MetricTable }>['column']

const METRIC_TABLES: readonly string[] = ['contact_metrics', 'organization_metrics']

export function isMetricTable(table: string): table is MetricTable {
  return METRIC_TABLES.includes(table)
}

export function systemFields(objectType: ObjectType): readonly SystemField[] {
  return SYSTEM_FIELDS[objectType]
}

export function systemField(objectType: ObjectType, slug: string): SystemField | undefined {
  return SYSTEM_FIELDS[objectType].find((field) => field.slug === slug)
}

/** The sidebar section a system field belongs to, if any. */
export function fieldGroup(field: SystemField): string | undefined {
  return 'group' in field ? field.group : undefined
}

/** Every system slug of every object type — the input to slug reservation (ADR-041). */
export function allSystemSlugs(objectType: ObjectType): readonly string[] {
  return SYSTEM_FIELDS[objectType].map((field) => field.slug)
}
