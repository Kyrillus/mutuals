/**
 * The state machine ADR-048 describes, in one place so the three surfaces that read it — the `⋮`
 * menu, the breadcrumb and Settings → Table views — cannot each guess differently.
 *
 * There are exactly three situations:
 *
 *   **no view**   `?view=` is absent. Only `Save as new view` does anything.
 *   **clean**     `?view=<id>` and the URL's snapshot equals the stored one.
 *   **dirty**     `?view=<id>` and they differ. `Save changes` and `Revert` both light up.
 *
 * A link carrying `?view=` *and* explicit parameters lands in **dirty** on purpose, and that is the
 * feature rather than an edge case: it is what makes sharing a tweaked view work (ADR-048).
 */
import {
  viewSnapshotsEqual,
  type ObjectType,
  type SavedView,
  type ViewSnapshot,
} from '@mutuals/core'
import { useMemo } from 'react'

import { useListQuery } from '@/hooks/use-list-query.ts'

import { useViews } from './use-views.ts'

export type ViewStatus = 'none' | 'clean' | 'dirty'

export interface ViewState {
  readonly views: readonly SavedView[]
  readonly current: SavedView | undefined
  readonly status: ViewStatus
  /** The working copy, as a snapshot — what `Save changes` and `Save as new` would store. */
  readonly snapshot: ViewSnapshot
  /** Load a view: its snapshot into the URL, its id into `?view=` (ADR-048). */
  open: (view: SavedView) => void
  /** Back to the stored snapshot, keeping `?view=`. */
  revert: () => void
  /** Leave the view entirely; the working copy stays as it is. */
  detach: () => void
}

function snapshotOf(view: SavedView): ViewSnapshot {
  return { filter: view.filters, sort: view.sort, columns: view.columns }
}

/**
 * `effectiveColumns` matters more than it looks. The URL omits `columns` entirely while the table
 * is showing its defaults, so a snapshot taken straight from `query.columns` would save `null` —
 * a view with no columns — and would then compare unequal to itself the moment the parameter became
 * explicit. The snapshot is always the columns actually on screen.
 */
export function useViewState(
  objectType: ObjectType,
  effectiveColumns: readonly string[] | null,
): ViewState {
  const { query, update } = useListQuery()
  const views = useViews(objectType).data ?? []

  const current = useMemo(
    () => (query.view === null ? undefined : views.find((view) => view.id === query.view)),
    [views, query.view],
  )

  const snapshot = useMemo<ViewSnapshot>(
    () => ({ filter: query.filter, sort: query.sort, columns: query.columns ?? effectiveColumns }),
    [query.filter, query.sort, query.columns, effectiveColumns],
  )

  const status: ViewStatus =
    current === undefined
      ? 'none'
      : viewSnapshotsEqual(snapshot, snapshotOf(current))
        ? 'clean'
        : 'dirty'

  return {
    views,
    current,
    status,
    snapshot,
    open: (view) => {
      update({ ...snapshotOf(view), view: view.id })
    },
    revert: () => {
      if (current === undefined) return
      update({ ...snapshotOf(current), view: current.id })
    },
    detach: () => {
      update({ view: null })
    },
  }
}
