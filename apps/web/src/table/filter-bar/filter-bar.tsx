/**
 * The filter bar (§5.2): `+ Add filter`, and one chip per active filter.
 *
 * Everything it offers is read from `FieldDescriptor[]` — system columns, the derived columns of
 * §5.2 and user-defined attributes in one namespace — and every operator it offers comes from that
 * field's own `operators`, which `packages/core` derives from `OPERATORS_BY_TYPE`. There is no
 * list of field names in this folder, and no list of operators either; that is the point
 * (ADR-052, and CLAUDE.md's one rule).
 *
 * Filters combine with **AND**, by design (ADR-032). There is no `any` toggle to add later without
 * a wire change, so there is none pretending to be one now.
 *
 * **State.** The working copy is the URL (ADR-048). A caller that already holds the query — the
 * DataTable's own route, which threads `filter` and `onChange` through — passes them in and the
 * bar is a controlled component. A caller that does not gets the same behaviour from
 * {@link useListQuery} directly. Exactly one of the two ever writes.
 */
import { MAX_FILTERS, type FieldDescriptor, type Filter, type FilterSet } from '@mutuals/core'
import { Plus } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'

import { formatCivilDate } from '@/attributes/format.ts'
import { useDisplay } from '@/attributes/display-context.tsx'
import { useListQuery } from '@/hooks/use-list-query.ts'
import { Button } from '@/ui/button.tsx'
import { TooltipProvider } from '@/ui/tooltip.tsx'

import { FilterChip } from './filter-chip.tsx'
import { FilterEditor } from './filter-editor.tsx'
import { dedupeFilters, filterKey } from './operators.ts'
import { Popover, PopoverContent, PopoverTrigger } from './popover.tsx'
import { relationRefs, useRecordLabels } from './relation.ts'
import { describeFilter } from './sentence.ts'

/**
 * Not a filter key — every real one is a JSON object — so the `+ Add filter` popover and a chip's
 * own editor can never both believe they are the open one.
 */
const NEW = 'new'

export interface FilterBarProps {
  /** Every field of this object type, resolved: `recordFieldResolver(…).list()`. */
  readonly fields: readonly FieldDescriptor[]
  /** Controlled mode. Omit both and the bar reads and writes `?filter=` itself. */
  readonly filter?: FilterSet
  readonly onChange?: (next: FilterSet) => void
}

export function FilterBar({ fields, filter: controlled, onChange }: FilterBarProps) {
  const url = useListQuery()
  const { locale } = useDisplay()

  const filters = controlled ?? url.query.filter
  const setFilters = onChange ?? url.setFilters

  /** The canonical key of the filter whose editor is open, or {@link NEW}. */
  const [editing, setEditing] = useState<string | null>(null)

  const bySlug = useMemo(() => new Map(fields.map((field) => [field.slug, field])), [fields])
  const formatDate = useCallback((civil: string) => formatCivilDate(civil, locale), [locale])
  const labels = useRecordLabels(relationRefs(filters, (slug) => bySlug.get(slug)))

  function commit(next: Filter, previousKey: string | null) {
    const known = previousKey !== null && filters.some((entry) => filterKey(entry) === previousKey)
    setFilters(
      dedupeFilters(
        known
          ? filters.map((entry) => (filterKey(entry) === previousKey ? next : entry))
          : [...filters, next],
      ),
    )
    // While the new-filter popover is open it keeps its own anchor and its own draft: handing the
    // editor to the chip it has just created would move the popover out from under the cursor in
    // the middle of ticking options.
    setEditing((current) => (current === NEW ? NEW : filterKey(next)))
  }

  function remove(key: string) {
    setFilters(filters.filter((entry) => filterKey(entry) !== key))
    setEditing(null)
  }

  const full = filters.length >= MAX_FILTERS

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex flex-wrap items-center gap-2">
        {filters.map((entry) => {
          const key = filterKey(entry)
          return (
            <FilterChip
              key={key}
              sentence={describeFilter(entry, bySlug.get(entry.field), {
                formatDate,
                recordLabels: labels,
              })}
              open={editing === key}
              onOpenChange={(open) => {
                setEditing(open ? key : null)
              }}
              onRemove={() => {
                remove(key)
              }}
            >
              <FilterEditor
                fields={fields}
                filter={entry}
                labels={labels}
                onCommit={commit}
                onRemove={remove}
                onClose={() => {
                  setEditing(null)
                }}
              />
            </FilterChip>
          )
        })}

        <Popover
          open={editing === NEW}
          onOpenChange={(open) => {
            setEditing(open ? NEW : null)
          }}
        >
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground h-7 gap-1 px-2 text-xs"
              disabled={full}
              title={
                full
                  ? `${String(MAX_FILTERS)} filters is the limit. Remove one to add another.`
                  : undefined
              }
            >
              <Plus />
              Add filter
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80">
            <FilterEditor
              fields={fields}
              labels={labels}
              onCommit={commit}
              onRemove={remove}
              onClose={() => {
                setEditing(null)
              }}
            />
          </PopoverContent>
        </Popover>
      </div>
    </TooltipProvider>
  )
}
