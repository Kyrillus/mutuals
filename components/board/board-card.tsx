'use client';

import { useDraggable } from '@dnd-kit/core';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';

import { cx, IconDrag, Spinner } from '@/components/ui';
import type { ContactListRow } from '@/lib/types';

/**
 * Die Zeile hinter einer Board-Karte.
 *
 * listBoardAction gibt laut Vertrag ContactListRow[] zurueck; lib/queries.ts
 * legt jeder Zeile zusaetzlich den aeltesten offenen Need bei (top_open_need).
 * Das Feld ist hier deshalb OPTIONAL deklariert: ContactListRow bleibt damit
 * zuweisbar, und die Karte kommt trotzdem ohne Cast an den Need - kein any,
 * kein "as", und wenn das Feld einmal fehlt, zeigt die Karte einfach zwei
 * Zeilen statt drei.
 */
export type BoardCardRow = ContactListRow & { top_open_need?: string | null };

/** Leere Strings aus dem Import zaehlen wie nicht gesetzt. */
function text(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Der sichtbare Inhalt einer Karte: Name, Firma, oberster offener Need.
 * Mehr nicht - eine Kanban-Karte, die alles zeigt, zeigt nichts.
 *
 * Fest 64px hoch (min-h-16), damit die Spalte ein ruhiges Raster bleibt, auch
 * wenn einem Kontakt die Firma oder der Need fehlt.
 */
const CARD_CLASS =
  'flex min-h-16 w-full items-center gap-1.5 rounded-sm border border-border bg-surface px-2.5 py-2';

function CardContent({ row, slot }: { row: BoardCardRow; slot: ReactNode }) {
  const company = text(row.company);
  const need = text(row.top_open_need);

  return (
    <>
      <span className="flex size-3.5 shrink-0 items-center justify-center text-faint">{slot}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-medium text-fg">{row.name}</span>
        {company === null ? null : <span className="truncate text-sm text-muted">{company}</span>}
        {need === null ? null : (
          <span className="truncate text-sm text-faint" title={need}>
            {need}
          </span>
        )}
      </span>
    </>
  );
}

export interface BoardCardProps {
  row: BoardCardRow;
  /** Der Zug wird gerade gespeichert: Karte gedaempft, Ziehen gesperrt. */
  pending: boolean;
  /** Oeffnet den Detail-Slide-over. Die Ansicht entscheidet, ob sie den Klick annimmt. */
  onOpen: (id: number) => void;
}

/**
 * Eine Karte im Board.
 *
 * Ziehbar ist die ganze Karte, nicht nur der Griff - der Griff links zeigt beim
 * Ueberfahren nur an, dass sie das ist, und haelt seinen Platz frei, damit beim
 * Hover nichts springt. Waehrend gespeichert wird, sitzt an derselben Stelle
 * der Spinner.
 *
 * Tastatur: die Karte ist ueber dnd-kit fokussierbar (role="button", tabIndex 0).
 * Die Leertaste nimmt sie auf, die Eingabetaste oeffnet die Detailansicht -
 * deshalb ist Enter in BOARD_KEYBOARD_CODES aus den Aufnehmen-Tasten entfernt
 * und wird hier selbst behandelt.
 */
export function BoardCard({ row, pending, onOpen }: BoardCardProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: row.id,
    disabled: pending,
    attributes: { roleDescription: 'Karte, verschiebbar' },
  });

  const dragKeyDown = listeners?.['onKeyDown'];

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    // Erst dnd-kit: die Leertaste nimmt die Karte auf und ruft preventDefault.
    if (typeof dragKeyDown === 'function') {
      dragKeyDown(event);
    }
    if (event.defaultPrevented || isDragging) {
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      onOpen(row.id);
    }
  }

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onKeyDown={handleKeyDown}
      onClick={() => onOpen(row.id)}
      aria-busy={pending || undefined}
      className={cx(
        CARD_CLASS,
        'group cursor-pointer text-left transition-colors duration-75',
        'hover:border-border-strong hover:bg-surface-sunken',
        isDragging && 'opacity-35',
        pending && 'opacity-60',
      )}
    >
      <CardContent
        row={row}
        slot={
          pending ? (
            <Spinner label="Karte wird verschoben" />
          ) : (
            <IconDrag className="opacity-0 transition-opacity duration-75 group-hover:opacity-100 group-focus-visible:opacity-100" />
          )
        }
      />
    </div>
  );
}

/**
 * Dieselbe Karte als Vorschau unter dem Zeiger (DragOverlay).
 *
 * Der Schatten ist hier erlaubt und nur hier: das Overlay liegt tatsaechlich
 * ueber der Anwendung. Der Griff steht dauerhaft sichtbar, weil die Karte in
 * diesem Moment genau das ist - gegriffen.
 */
export function BoardCardPreview({ row }: { row: BoardCardRow }) {
  return (
    <div className={cx(CARD_CLASS, 'cursor-grabbing border-border-strong shadow-md')}>
      <CardContent row={row} slot={<IconDrag />} />
    </div>
  );
}
