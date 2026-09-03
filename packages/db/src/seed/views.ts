/**
 * The default saved views of §6.2 — `All contacts`, `Investors`, `Founders`,
 * `No interaction in 90 days` — plus one for the organizations table.
 *
 * A view is a named snapshot of `(columns, filters, sort)` (ADR-048), stored in exactly the wire
 * shapes `@mutuals/core` parses: `Filter[]` for `filters`, `SortRequest` for `sort`, and a list of
 * field slugs for `columns`. Nothing here invents a serialisation of its own, so a view written by
 * the seed and a view written by the UI are the same row.
 *
 * A `single_select` filter carries the option's **stable key**, not its label and not its uuid:
 * `coerceOptionIds` in the compiler resolves `values` through `findOptionByKey`. The label is
 * renameable and the key is not, so a view survives somebody renaming "Investor" to "VC".
 */
import type { Filter, SortRequest } from '@mutuals/core'

import type { Executor } from '../write/types.ts'
import { resolveWorkspaceId } from '../write/workspace.ts'
import type { ObjectType } from '../schema.ts'

/** §6.2's default column set for the contacts table, in display order. */
const CONTACT_COLUMNS = [
  'display_name',
  'email',
  'phone',
  'organization',
  'job_role',
  'city',
  'areas_of_interest',
  'last_interaction_at',
  'created_at',
] as const

/** §6.3's default column set for the organizations table. */
const ORGANIZATION_COLUMNS = [
  'name',
  'type',
  'industry',
  'city',
  'country',
  'people_count',
  'website',
  'created_at',
] as const

export interface SavedViewSeed {
  readonly objectType: ObjectType
  readonly name: string
  readonly isDefault: boolean
  readonly columns: readonly string[]
  readonly filters: readonly Filter[]
  readonly sort: SortRequest | null
  readonly position: number
}

export const DEFAULT_VIEWS: readonly SavedViewSeed[] = [
  {
    objectType: 'contact',
    name: 'All contacts',
    isDefault: true,
    columns: CONTACT_COLUMNS,
    filters: [],
    sort: null,
    position: 0,
  },
  {
    objectType: 'contact',
    name: 'Investors',
    isDefault: false,
    columns: CONTACT_COLUMNS,
    filters: [{ field: 'job_role', op: 'is_one_of', values: ['investor'] }],
    sort: { field: 'display_name', direction: 'asc' },
    position: 1,
  },
  {
    objectType: 'contact',
    name: 'Founders',
    isDefault: false,
    columns: CONTACT_COLUMNS,
    filters: [{ field: 'job_role', op: 'is_one_of', values: ['founder'] }],
    sort: { field: 'display_name', direction: 'asc' },
    position: 2,
  },
  {
    objectType: 'contact',
    name: 'No interaction in 90 days',
    isDefault: false,
    // `warmth` earns its place here: the point of the view is who to call, and warmth is the rank.
    columns: [...CONTACT_COLUMNS.slice(0, 8), 'warmth'],
    // Filters are AND-only (ADR-032), so this is the literal reading of the name: somebody whose
    // last interaction is more than ninety days old. A contact who has NEVER been in touch has a
    // NULL `last_interaction_at` and therefore does NOT appear — see the note in ARCHITECTURE.md;
    // covering both cases needs an OR, which is a wire change and not a decision for a seed script.
    filters: [{ field: 'last_interaction_at', op: 'older_than', n: 90, unit: 'day' }],
    sort: { field: 'last_interaction_at', direction: 'asc' },
    position: 3,
  },
  {
    objectType: 'contact',
    // The other half of the view above. Because filters are AND-only, "gone quiet" and "never
    // spoke" cannot share one view -- so rather than a view whose name promises more than it can
    // deliver, they are two views that each mean exactly what they say. This is the answer to the
    // plan's open question Q3, and it is arguably the more actionable of the pair: a freshly
    // imported LinkedIn export lands entirely in here rather than swamping the other one.
    name: 'Never contacted',
    isDefault: false,
    columns: [...CONTACT_COLUMNS.slice(0, 8), 'created_at'],
    filters: [{ field: 'last_interaction_at', op: 'is_empty' }],
    sort: { field: 'created_at', direction: 'desc' },
    position: 4,
  },
  {
    objectType: 'organization',
    name: 'All organizations',
    isDefault: true,
    columns: ORGANIZATION_COLUMNS,
    filters: [],
    sort: null,
    position: 0,
  },
]

/**
 * Writes the default views. `ON CONFLICT` on the `(workspace, object_type, name)` unique makes a
 * re-run an update rather than a duplicate-key error, so `pnpm seed` is safe to repeat even when
 * the caller skipped the reset.
 */
export async function seedDefaultViews(
  exec: Executor,
  workspaceId?: string | null,
): Promise<number> {
  const workspace = await resolveWorkspaceId(exec, workspaceId)

  const rows = DEFAULT_VIEWS.map((view) => ({
    workspace_id: workspace,
    object_type: view.objectType,
    name: view.name,
    is_default: view.isDefault,
    columns: JSON.stringify(view.columns),
    filters: JSON.stringify(view.filters),
    sort: view.sort === null ? null : JSON.stringify(view.sort),
    position: view.position,
  }))

  const inserted = await exec
    .insertInto('saved_view')
    .values(rows)
    .onConflict((conflict) =>
      conflict.columns(['workspace_id', 'object_type', 'name']).doUpdateSet((eb) => ({
        is_default: eb.ref('excluded.is_default'),
        columns: eb.ref('excluded.columns'),
        filters: eb.ref('excluded.filters'),
        sort: eb.ref('excluded.sort'),
        position: eb.ref('excluded.position'),
        updated_at: new Date(),
      })),
    )
    .execute()

  return inserted.length
}
