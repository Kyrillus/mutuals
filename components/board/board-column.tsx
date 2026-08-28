'use client';

import { useDroppable } from '@dnd-kit/core';
import { useId } from 'react';

import { cx, EmptyState } from '@/components/ui';
import { STAGE_LABELS, type Stage } from '@/lib/constants';

import { BoardCard, type BoardCardRow } from './board-card';

export interface BoardColumnProps {
  stage: Stage;
  rows: readonly BoardCardRow[];
  /** Karten, deren Zug gerade gespeichert wird. */
  pendingIds: ReadonlySet<number>;
  /** Es wird gerade irgendeine Karte gezogen. */
  dragging: boolean;
  onOpen: (id: number) => void;
}

/**
 * Eine Spalte des Boards - eine Phase.
 *
 * Kopf und Koerper sind getrennte Flex-Kinder: der Kopf bleibt stehen, der
 * Koerper scrollt fuer sich (overflow-y-auto). Weil der Kopf ausserhalb des
 * Scrollbereichs liegt, braucht er keinen eigenen Hintergrund und keine
 * Trennlinie - die Karten verschwinden sauber an seiner Unterkante.
 *
 * Der Koerper ist zugleich das Ablageziel. Er fuellt die restliche Hoehe, damit
 * auch eine leere Spalte eine grosse Trefferflaeche hat; waehrend ein Zug
 * darueber schwebt, hebt er sich ueber die Flaeche hervor (surface-sunken),
 * nicht ueber die Akzentfarbe.
 */
export function BoardColumn({ stage, rows, pendingIds, dragging, onOpen }: BoardColumnProps) {
  const { isOver, setNodeRef } = useDroppable({ id: stage });
  const headingId = useId();

  return (
    <section
      aria-labelledby={headingId}
      className="flex w-[264px] shrink-0 flex-col border-r border-border last:border-r-0"
    >
      <header className="flex h-9 shrink-0 items-center gap-1.5 px-3">
        <h2 id={headingId} className="flex items-baseline gap-1.5 font-medium text-fg">
          {STAGE_LABELS[stage]}
          <span className="text-sm font-normal text-faint tabular-nums">{rows.length}</span>
        </h2>
      </header>

      <div
        ref={setNodeRef}
        className={cx(
          'min-h-0 flex-1 overflow-y-auto px-2 pb-4 transition-colors duration-100',
          dragging && isOver && 'bg-surface-sunken',
        )}
      >
        {rows.length === 0 ? (
          <EmptyState
            title="Noch keine Kontakte in dieser Phase"
            description="Karten aus anderen Phasen lassen sich hierher ziehen."
          />
        ) : (
          <ul className="flex flex-col gap-1.5">
            {rows.map((row) => (
              <li key={row.id}>
                <BoardCard row={row} pending={pendingIds.has(row.id)} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
