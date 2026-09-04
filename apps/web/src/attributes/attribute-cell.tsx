/**
 * The cell registry (ADR-052): one read-only renderer per attribute type, and nothing else in the
 * frontend that decides what a value looks like.
 *
 * Exhaustiveness is structural, not a lint rule. `ATTRIBUTE_CELLS` is typed
 * `{ [T in AttributeType]: AttributeCellRenderer<T> }`, so a thirteenth type is a missing-key
 * error, and each renderer receives the value shape its own type carries — wiring the `email`
 * renderer to the `tags` key does not compile, because one takes a string and the other an array.
 * That is the strong form of "attribute definitions drive everything": there is no `switch` on a
 * slug here, and no place to add one.
 *
 * Every renderer fits inside ADR-053's fixed 40px row. Nothing wraps, nothing measures, nothing
 * grows: a long value truncates or clips, exactly as `docs/refs/02-contacts-table.png` does.
 */
import type { AttributeType, AttributeValue, ObjectType } from '@mutuals/core'
import { Building2, Check, MessageSquare, User, X } from 'lucide-react'
import { useMemo, type ComponentType, type ReactNode } from 'react'

import { cn } from '@/lib/utils.ts'
import { Chip } from '@/ui/chip.tsx'

import { useDisplay } from './display-context.tsx'
import {
  formatCivilDate,
  formatNumber,
  formatPhone,
  mailtoHref,
  phoneHref,
  prettyUrl,
} from './format.ts'
import { numberDisplayOf, type AttributeReadValue, type AttributeSpec } from './value.ts'

export interface AttributeCellProps<T extends AttributeType = AttributeType> {
  /** The definition drives the rendering; nothing here ever reads `definition.slug`. */
  readonly definition: AttributeSpec
  /** Present by construction — {@link AttributeCell} handles absence before it dispatches. */
  readonly value: AttributeReadValue<T>
}

export type AttributeCellRenderer<T extends AttributeType> = (
  props: AttributeCellProps<T>,
) => ReactNode

/** §5.2's "empty as a subtle placeholder": an em dash, quiet enough to read as texture. */
export function EmptyValue() {
  return <span className="text-muted-foreground/60 tabular-nums">—</span>
}

function TruncatedText({ value, className }: { value: string; className?: string }) {
  return (
    <span className={cn('block truncate', className)} title={value}>
      {value}
    </span>
  )
}

function ShortTextCell({ value }: AttributeCellProps<'short_text'>) {
  return <TruncatedText value={value} />
}

/**
 * Markdown prose in a 40px row. Newlines become spaces first: without that the first line would
 * be the whole preview and a note starting with a heading marker would render as `#`.
 */
function LongTextCell({ value }: AttributeCellProps<'long_text'>) {
  return <TruncatedText className="text-muted-foreground" value={value.replace(/\s+/gu, ' ')} />
}

function NumberCell({ definition, value }: AttributeCellProps<'number'>) {
  const { locale } = useDisplay()
  // The config is parsed through zod, and this runs in every visible cell of a virtualised table.
  // The definition comes from the query cache and its identity is stable, so the memo holds.
  const display = useMemo(() => numberDisplayOf(definition), [definition])
  return (
    <span className="block truncate text-right tabular-nums">
      {formatNumber(value, display, locale)}
    </span>
  )
}

/**
 * A calendar day, absolutely. Relative wording is reserved for the derived timestamps §6.2 asks
 * for it on ("Last interaction: 3 weeks ago") — a birthday shown as "34 years ago" would be a
 * different fact about the same value, and the wrong one.
 */
function DateCell({ value }: AttributeCellProps<'date'>) {
  const { locale } = useDisplay()
  return <span className="block truncate tabular-nums">{formatCivilDate(value, locale)}</span>
}

/** §4.2's nullable boolean: a tick or a cross, and never a blank for the third state. */
function YesNoCell({ value }: AttributeCellProps<'yes_no'>) {
  return value ? (
    <Check role="img" className="text-chip-green-fg size-4" aria-label="Yes" />
  ) : (
    <X role="img" className="text-muted-foreground size-4" aria-label="No" />
  )
}

function SingleSelectCell({ value }: AttributeCellProps<'single_select'>) {
  return <Chip color={value.color}>{value.label}</Chip>
}

/**
 * Several chips on one line. The row clips rather than growing (ADR-053 fixes its height), and the
 * `title` carries the full list so nothing is unreachable.
 */
function ChipRow({ children, title }: { children: ReactNode; title: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1 overflow-hidden" title={title}>
      {children}
    </span>
  )
}

function MultiSelectCell({ value }: AttributeCellProps<'multi_select'>) {
  return (
    <ChipRow title={value.map((option) => option.label).join(', ')}>
      {value.map((option) => (
        <Chip key={option.key} color={option.color}>
          {option.label}
        </Chip>
      ))}
    </ChipRow>
  )
}

/** Tags have no option row and therefore no colour: they are grey by definition, not by default. */
function TagsCell({ value }: AttributeCellProps<'tags'>) {
  return (
    <ChipRow title={value.join(', ')}>
      {value.map((tag) => (
        <Chip key={tag}>{tag}</Chip>
      ))}
    </ChipRow>
  )
}

const LINK_CLASSES =
  'block truncate text-primary underline-offset-2 hover:underline focus-visible:underline outline-none'

function UrlCell({ value }: AttributeCellProps<'url'>) {
  return (
    <a
      href={value}
      target="_blank"
      rel="noreferrer noopener"
      title={value}
      className={LINK_CLASSES}
      // The row is clickable in its own right; a link inside it must not also open the record.
      onClick={(event) => {
        event.stopPropagation()
      }}
    >
      {prettyUrl(value)}
    </a>
  )
}

function EmailCell({ value }: AttributeCellProps<'email'>) {
  return (
    <a
      href={mailtoHref(value)}
      title={value}
      className={LINK_CLASSES}
      onClick={(event) => {
        event.stopPropagation()
      }}
    >
      {value}
    </a>
  )
}

/**
 * A `tel:` link when there is something dialable, plain text otherwise — a number the write path
 * could not normalise is still worth showing, and is shown exactly as it was typed.
 */
function PhoneCell({ value }: AttributeCellProps<'phone'>) {
  const href = phoneHref(value)
  const display = formatPhone(value)
  if (href === undefined) return <TruncatedText value={display} />
  return (
    <a
      href={href}
      title={value}
      className={cn(LINK_CLASSES, 'tabular-nums')}
      onClick={(event) => {
        event.stopPropagation()
      }}
    >
      {display}
    </a>
  )
}

/** The icon is chosen from the closed `object_type` enum, never from a field name. */
const RECORD_ICONS: Record<ObjectType, ComponentType<{ className?: string }>> = {
  contact: User,
  organization: Building2,
  interaction: MessageSquare,
}

/**
 * §5.2: "relations as chips with an icon that link to the record".
 *
 * The href comes from the display context so Stage 3 can point it at the real detail route without
 * touching this file, and the click is stopped so following a link never also selects the row.
 */
function RelationCell({ value }: AttributeCellProps<'relation'>) {
  const { recordHref } = useDisplay()
  return (
    <ChipRow title={value.map((record) => record.label).join(', ')}>
      {value.map((record) => {
        const Icon = RECORD_ICONS[record.objectType]
        return (
          <a
            key={record.id}
            href={recordHref(record.objectType, record.id)}
            className="min-w-0 outline-none"
            title={record.title === null ? record.label : `${record.label} — ${record.title}`}
            onClick={(event) => {
              event.stopPropagation()
            }}
          >
            <Chip className="hover:border-foreground/25">
              <Icon className="size-3 shrink-0 opacity-70" />
              <span className="truncate">{record.label}</span>
            </Chip>
          </a>
        )
      })}
    </ChipRow>
  )
}

export type AttributeCellRegistry = {
  readonly [T in AttributeType]: AttributeCellRenderer<T>
}

/** ADR-052's cell registry. Twelve entries, checked against twelve value shapes. */
export const ATTRIBUTE_CELLS: AttributeCellRegistry = {
  short_text: ShortTextCell,
  long_text: LongTextCell,
  number: NumberCell,
  date: DateCell,
  yes_no: YesNoCell,
  single_select: SingleSelectCell,
  multi_select: MultiSelectCell,
  tags: TagsCell,
  url: UrlCell,
  email: EmailCell,
  phone: PhoneCell,
  relation: RelationCell,
}

/**
 * Renders one value of one attribute, whatever its type.
 *
 * Absence is handled once, here, rather than twelve times: ADR-017 makes an absent key the single
 * definition of empty, so every renderer below can assume it has a value.
 */
export function AttributeCell({
  definition,
  value,
}: {
  definition: AttributeSpec
  value: AttributeValue | undefined
}) {
  if (value === undefined) return <EmptyValue />

  // The one cast in this file, and it buys the twelve above their precise types. `ATTRIBUTE_CELLS`
  // indexed by a non-literal widens to a union of twelve renderers whose parameters intersect to
  // `never`, so TypeScript refuses the call even though `value.type` has just proved it correct.
  // The registry's *definition* stays fully checked; what is asserted here is only that the value
  // tagged `t` is the value shape for `t`, which its own discriminant already says.
  const Renderer = ATTRIBUTE_CELLS[value.type] as AttributeCellRenderer<AttributeType>
  return <Renderer definition={definition} value={value.value} />
}
