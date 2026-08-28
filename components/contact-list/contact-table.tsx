'use client';

import { useRef, type KeyboardEvent, type ReactNode } from 'react';

import { ROLE_LABELS, STAGE_LABELS } from '@/lib/constants';
import { formatDate, formatRelative } from '@/lib/format';
import type { ContactSortColumn } from '@/lib/queries';
import type { ContactListRow } from '@/lib/types';
import { Badge, EmptyState, IconArrowDown, IconArrowUp, cx } from '@/components/ui';

/**
 * Die Kontakttabelle.
 *
 * Dicht und scanbar: 36px Zeilenhoehe, 32px Kopfzeile, Trennung ausschliesslich
 * ueber 1px-Linien. Die Hierarchie liegt im Gewicht und in der Farbe - der Name
 * steht in fg und halbfett, alles Uebrige in muted bei gleicher Groesse. Keine
 * Karten, keine Schatten, keine zweite Schriftgroesse.
 *
 * Sortiert wird NICHT hier: die Komponente meldet nur den Klick auf eine
 * Spaltenueberschrift nach oben, die Reihenfolge kommt aus der Datenbank
 * (listContactsAction). Eine im Browser nachsortierte Liste waere bei jeder
 * spaeteren Teilaktualisierung wieder falsch.
 *
 * Der Tastaturzeiger (Pfeil hoch/runter, Pos1/Ende, Enter) lebt hier, weil er
 * die DOM-Knoten der Zeilen braucht. Er ist als "roving tabindex" gebaut: genau
 * eine Zeile ist tabbierbar, die uebrigen tragen tabIndex -1. So springt die
 * Tabulatortaste ueber die Liste hinweg statt durch 128 Zeilen, und der Fokus
 * bleibt trotzdem immer sichtbar auf einer echten Zeile.
 */

export type SortDirection = 'asc' | 'desc';

export interface SortState {
  column: ContactSortColumn;
  direction: SortDirection;
}

const DASH = '—';

interface Column {
  key: string;
  label: string;
  /** Fehlt der Wert, ist die Spalte nicht sortierbar. */
  sort?: ContactSortColumn;
  /**
   * Richtung beim ERSTEN Klick auf diese Spalte. Text laeuft aufsteigend
   * (A vor Z), Zahlen und Daten absteigend - "letzter Kontakt" will man
   * zuerst als "zuletzt gesprochen" sehen, nicht als "vor drei Jahren".
   * Der zweite Klick dreht in beiden Faellen um.
   */
  firstDirection: SortDirection;
  /** Breite in Prozent, gesetzt ueber <colgroup> bei table-fixed. */
  width: string;
  align?: 'right';
  cell: (row: ContactListRow) => ReactNode;
}

const COLUMNS: readonly Column[] = [
  {
    key: 'name',
    label: 'Name',
    sort: 'name',
    firstDirection: 'asc',
    width: 'w-[24%]',
    cell: (row) => <span className="font-medium text-fg">{row.name}</span>,
  },
  {
    key: 'role',
    label: 'Rolle',
    firstDirection: 'asc',
    width: 'w-[11%]',
    cell: (row) => (row.role === null ? <span className="text-faint">{DASH}</span> : ROLE_LABELS[row.role]),
  },
  {
    key: 'company',
    label: 'Firma',
    sort: 'company',
    firstDirection: 'asc',
    width: 'w-[20%]',
    cell: (row) =>
      row.company === null ? (
        <span className="text-faint">{DASH}</span>
      ) : (
        <span className="text-fg">{row.company}</span>
      ),
  },
  {
    key: 'city',
    label: 'Stadt',
    sort: 'city',
    firstDirection: 'asc',
    width: 'w-[13%]',
    cell: (row) => (row.city === null ? <span className="text-faint">{DASH}</span> : row.city),
  },
  {
    key: 'stage',
    label: 'Phase',
    sort: 'stage',
    firstDirection: 'asc',
    width: 'w-[12%]',
    cell: (row) => <Badge>{STAGE_LABELS[row.stage]}</Badge>,
  },
  {
    key: 'open_needs_count',
    label: 'Offene Needs',
    sort: 'open_needs_count',
    firstDirection: 'desc',
    width: 'w-[10%]',
    align: 'right',
    cell: (row) => (
      <span className={cx('tabular-nums', row.open_needs_count === 0 && 'text-faint')}>
        {row.open_needs_count}
      </span>
    ),
  },
  {
    key: 'last_contact_at',
    label: 'Letzter Kontakt',
    sort: 'last_contact_at',
    firstDirection: 'desc',
    width: 'w-[10%]',
    cell: (row) => (
      <span
        className={cx(row.last_contact_at === null && 'text-faint')}
        title={row.last_contact_at === null ? undefined : formatDate(row.last_contact_at)}
      >
        {formatRelative(row.last_contact_at)}
      </span>
    ),
  },
];

/** Innenabstand einer Zelle. Aussen buendig mit der Filterleiste (24px). */
function cellPadding(index: number): string {
  if (index === 0) {
    return 'pl-6 pr-2';
  }
  if (index === COLUMNS.length - 1) {
    return 'pl-2 pr-6';
  }
  return 'px-2';
}

export interface ContactTableProps {
  rows: ContactListRow[];
  sort: SortState | null;
  onSortChange: (next: SortState) => void;
  /** Kontakt, dessen Slide-over gerade offen ist. Bleibt markiert. */
  selectedId: number | null;
  onOpen: (id: number) => void;
  /** true, sobald irgendein Filter oder ein Suchbegriff gesetzt ist. */
  filtered: boolean;
  /** false heisst: die Datenbank ist leer, nicht der Filter zu eng. */
  hasAnyContacts: boolean;
  onResetFilters: () => void;
  /** Waehrend einer laufenden Abfrage ruhig abgedunkelt statt ausgetauscht. */
  dimmed: boolean;
}

export function ContactTable({
  rows,
  sort,
  onSortChange,
  selectedId,
  onOpen,
  filtered,
  hasAnyContacts,
  onResetFilters,
  dimmed,
}: ContactTableProps) {
  const rowRefs = useRef(new Map<number, HTMLTableRowElement>());

  /**
   * Der Tastaturzeiger wird ueber die Kontakt-ID gefuehrt, nicht ueber den
   * Index: nach einem Filterwechsel steht an Index 3 ein anderer Mensch, die
   * ID dagegen zeigt weiter auf dieselbe Zeile - oder auf keine, dann faellt
   * der Zeiger sauber auf die erste zurueck.
   */
  const cursorRef = useRef<number | null>(null);
  const cursorIndex = rows.findIndex((row) => row.id === cursorRef.current);
  const activeIndex = cursorIndex >= 0 ? cursorIndex : 0;

  function focusRowAt(index: number): void {
    const target = rows[index];
    if (target === undefined) {
      return;
    }
    cursorRef.current = target.id;
    rowRefs.current.get(target.id)?.focus();
  }

  function handleRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, index: number): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusRowAt(Math.min(index + 1, rows.length - 1));
        return;
      case 'ArrowUp':
        event.preventDefault();
        focusRowAt(Math.max(index - 1, 0));
        return;
      case 'Home':
        event.preventDefault();
        focusRowAt(0);
        return;
      case 'End':
        event.preventDefault();
        focusRowAt(rows.length - 1);
        return;
      case 'Enter':
        event.preventDefault();
        onOpen(rows[index]?.id ?? 0);
        return;
      default:
    }
  }

  function handleHeaderClick(column: Column): void {
    if (column.sort === undefined) {
      return;
    }
    const active = sort !== null && sort.column === column.sort;
    const direction: SortDirection = active
      ? sort.direction === 'asc'
        ? 'desc'
        : 'asc'
      : column.firstDirection;
    onSortChange({ column: column.sort, direction });
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full min-w-[900px] border-separate border-spacing-0 text-base">
        <caption className="sr-only">
          Kontakte, sortierbar ueber die Spaltenueberschriften. Mit Pfeil hoch und Pfeil runter
          durch die Zeilen, Enter oeffnet die Detailansicht.
        </caption>

        <colgroup>
          {COLUMNS.map((column) => (
            <col key={column.key} className={column.width} />
          ))}
        </colgroup>

        <thead>
          <tr>
            {COLUMNS.map((column, index) => {
              const active = sort !== null && column.sort !== undefined && sort.column === column.sort;
              return (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
                  className={cx(
                    'sticky top-0 z-10 h-8 border-b border-border bg-bg text-left align-middle',
                    'text-sm font-medium text-muted',
                    cellPadding(index),
                  )}
                >
                  {column.sort === undefined ? (
                    <span className={cx('block', column.align === 'right' && 'text-right')}>
                      {column.label}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleHeaderClick(column)}
                      className={cx(
                        'group -mx-1 flex h-6 w-[calc(100%+0.5rem)] items-center gap-1 rounded-xs px-1',
                        'transition-colors duration-75 hover:text-fg',
                        active && 'text-fg',
                        column.align === 'right' && 'justify-end',
                      )}
                    >
                      <span className="truncate">{column.label}</span>
                      {/* Feste Breite: der Pfeil darf die Spaltenbreite nicht veraendern. */}
                      <span className="inline-flex w-3.5 shrink-0 justify-center">
                        {active ? (
                          sort.direction === 'asc' ? (
                            <IconArrowUp width="12" height="12" />
                          ) : (
                            <IconArrowDown width="12" height="12" />
                          )
                        ) : (
                          <IconArrowUp
                            width="12"
                            height="12"
                            className="text-faint opacity-0 transition-opacity duration-75 group-hover:opacity-100"
                          />
                        )}
                      </span>
                    </button>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>

        <tbody
          className={cx('transition-opacity duration-150', dimmed ? 'opacity-45' : 'opacity-100')}
        >
          {rows.length === 0 ? (
            <tr>
              <td colSpan={COLUMNS.length} className="px-6">
                {hasAnyContacts || filtered ? (
                  <EmptyState
                    title="Kein Kontakt passt zu dieser Auswahl."
                    description="Andere Filter setzen oder den Suchbegriff kuerzen."
                    action={
                      <button
                        type="button"
                        onClick={onResetFilters}
                        className="rounded-xs text-base font-medium text-accent underline-offset-2 hover:underline"
                      >
                        Filter zuruecksetzen
                      </button>
                    }
                  />
                ) : (
                  <EmptyState
                    title="Noch keine Kontakte erfasst."
                    description="Ueber Import laesst sich ein LinkedIn-Export oder eine CSV-Datei einlesen."
                  />
                )}
              </td>
            </tr>
          ) : (
            rows.map((row, index) => {
              const selected = row.id === selectedId;
              return (
                <tr
                  key={row.id}
                  ref={(node) => {
                    if (node === null) {
                      rowRefs.current.delete(row.id);
                    } else {
                      rowRefs.current.set(row.id, node);
                    }
                  }}
                  tabIndex={index === activeIndex ? 0 : -1}
                  aria-selected={selected}
                  onClick={() => {
                    cursorRef.current = row.id;
                    onOpen(row.id);
                  }}
                  onFocus={() => {
                    cursorRef.current = row.id;
                  }}
                  onKeyDown={(event) => handleRowKeyDown(event, index)}
                  className={cx(
                    'group/row cursor-default scroll-mt-8 transition-colors duration-75',
                    'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                    selected ? 'bg-surface-sunken' : 'hover:bg-surface-sunken',
                  )}
                >
                  {COLUMNS.map((column, columnIndex) => (
                    <td
                      key={column.key}
                      className={cx(
                        'relative h-9 truncate border-b border-border align-middle text-muted',
                        column.align === 'right' && 'text-right',
                        cellPadding(columnIndex),
                        // Der Balken markiert die Zeile, deren Slide-over offen
                        // ist. Einzige Stelle in dieser Ansicht, an der die
                        // Akzentfarbe auftaucht - sie zeigt, wo man gerade ist.
                        columnIndex === 0 &&
                          selected &&
                          'before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-accent',
                      )}
                    >
                      {column.cell(row)}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
