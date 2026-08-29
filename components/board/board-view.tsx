'use client';

/**
 * Das Board.
 *
 * Fuenf Spalten in der Reihenfolge aus STAGES, darin die aktiven Kontakte als
 * kompakte Karten. Ziehen verschiebt zwischen den Phasen und speichert sofort.
 *
 * DER ZUSTAND, in Kurzform: die Wahrheit steht auf dem Server. Diese Ansicht
 * bekommt das fertige Board als Prop und legt waehrend eines laufenden
 * Speicherns nur eine Schicht darueber (useOptimistic). Die Schicht kennt
 * genau zwei Dinge - wohin die Karte gehoert und dass sie gerade unterwegs ist
 * -, und React verwirft sie von selbst, sobald die Server Action fertig ist
 * und die neuen Daten eintreffen. Deshalb gibt es hier kein Zurueckrollen von
 * Hand: schlaegt setStageAction fehl, bleibt die Serverantwort einfach die
 * alte, die Karte springt zurueck und die Meldung sagt, warum.
 *
 * Der Vorteil gegenueber einer eigenen Kopie in useState: es gibt keinen
 * zweiten Datenstand, der auseinanderlaufen kann. Auch die Kartenzahl in den
 * Spaltenkoepfen kommt aus derselben Ableitung und stimmt damit im selben
 * Bild, in dem die Karte umzieht.
 */

import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type {
  Announcements,
  DragEndEvent,
  DragStartEvent,
  UniqueIdentifier,
} from '@dnd-kit/core';
import { useRouter } from 'next/navigation';
import { startTransition, useCallback, useId, useMemo, useOptimistic, useRef, useState } from 'react';

import { setStageAction } from '@/app/actions';
import { ContactDetailSheet } from '@/components/contact-detail';
import { Button, IconClose, InlineError } from '@/components/ui';
import { STAGES, STAGE_LABELS, isStage, type Stage } from '@/lib/constants';

import type { BoardCardRow } from './board-card';
import { BoardCardPreview } from './board-card';
import { BoardColumn } from './board-column';
import {
  BOARD_KEYBOARD_CODES,
  BOARD_SCREEN_READER_INSTRUCTIONS,
  boardKeyboardCoordinates,
} from './board-keyboard';

export type BoardColumns = Record<Stage, readonly BoardCardRow[]>;

/** Der abgeleitete Stand: Karten je Spalte plus die gerade laufenden Zuege. */
interface BoardState {
  columns: BoardColumns;
  pending: ReadonlySet<number>;
}

interface Move {
  id: number;
  to: Stage;
}

const NO_PENDING: ReadonlySet<number> = new Set<number>();

/**
 * Dieselbe Sortierung, die listContacts liefert: nach Name, dann nach id.
 *
 * Damit landet eine optimistisch verschobene Karte gleich an der Stelle, an
 * der sie nach dem Neuladen auch stehen wird - sonst haette jeder Zug ein
 * kleines Nachrutschen zur Folge. SQLite faltet mit COLLATE NOCASE nur ASCII,
 * dieser Vergleich auch Umlaute; in dem seltenen Fall, dass sich beide
 * uneinig sind, korrigiert die Serverantwort die Position.
 */
const COLLATOR = new Intl.Collator('de', { sensitivity: 'base' });

function insertSorted(rows: readonly BoardCardRow[], row: BoardCardRow): BoardCardRow[] {
  const next = rows.slice();
  const index = next.findIndex((other) => {
    const byName = COLLATOR.compare(other.name, row.name);
    return byName > 0 || (byName === 0 && other.id > row.id);
  });
  if (index === -1) {
    next.push(row);
  } else {
    next.splice(index, 0, row);
  }
  return next;
}

/**
 * Die optimistische Schicht: eine Karte umhaengen und als "wird gespeichert"
 * markieren. React wendet diese Funktion bei jedem neuen Serverstand erneut
 * auf alle noch laufenden Zuege an - sie muss deshalb aus einem beliebigen
 * Ausgangsstand das Richtige tun und darf nichts ausserhalb veraendern.
 */
function applyMove(state: BoardState, move: Move): BoardState {
  const pending = new Set(state.pending);
  pending.add(move.id);

  let from: Stage | null = null;
  let row: BoardCardRow | undefined;
  for (const stage of STAGES) {
    const found = state.columns[stage].find((entry) => entry.id === move.id);
    if (found !== undefined) {
      from = stage;
      row = found;
      break;
    }
  }

  // Karte unbekannt oder schon angekommen: nur der Ladezustand bleibt.
  if (from === null || row === undefined || from === move.to) {
    return { columns: state.columns, pending };
  }

  const columns: Record<Stage, readonly BoardCardRow[]> = { ...state.columns };
  columns[from] = state.columns[from].filter((entry) => entry.id !== move.id);
  columns[move.to] = insertSorted(state.columns[move.to], { ...row, stage: move.to });

  return { columns, pending };
}

/** dnd-kit erlaubt Text-IDs; auf dem Board sind es immer Kontakt-IDs. */
function toContactId(value: UniqueIdentifier): number | null {
  return typeof value === 'number' ? value : null;
}

/**
 * Wie lange nach einem Zug ein Klick noch zum Zug gehoert.
 *
 * Nach dem Loslassen feuert der Browser auf demselben Element ein click. Ohne
 * diese Sperre wuerde jedes Verschieben zusaetzlich die Detailansicht oeffnen.
 */
const CLICK_AFTER_DRAG_MS = 250;

export interface BoardViewProps {
  /** Das fertige Board vom Server, alle fuenf Phasen enthalten. */
  board: BoardColumns;
}

export function BoardView({ board }: BoardViewProps) {
  const router = useRouter();

  const base = useMemo<BoardState>(() => ({ columns: board, pending: NO_PENDING }), [board]);
  const [state, queueMove] = useOptimistic(base, applyMove);

  const [activeId, setActiveId] = useState<number | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dragEndedAt = useRef(0);

  const rowsById = useMemo(() => {
    const map = new Map<number, BoardCardRow>();
    for (const stage of STAGES) {
      for (const row of state.columns[stage]) {
        map.set(row.id, row);
      }
    }
    return map;
  }, [state.columns]);

  const total = rowsById.size;
  const activeRow = activeId === null ? null : (rowsById.get(activeId) ?? null);

  const dndContextId = useId();

  const sensors = useSensors(
    // 4px Toleranz: ein Klick auf die Karte soll die Detailansicht oeffnen und
    // nicht als Mini-Zug enden.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      keyboardCodes: BOARD_KEYBOARD_CODES,
      coordinateGetter: boardKeyboardCoordinates,
    }),
  );

  const announcements = useMemo<Announcements>(() => {
    function cardName(id: UniqueIdentifier): string {
      const contactId = toContactId(id);
      const row = contactId === null ? undefined : rowsById.get(contactId);
      return row?.name ?? 'Die Karte';
    }
    function stageName(over: { id: UniqueIdentifier } | null): string | null {
      if (over === null || !isStage(over.id)) {
        return null;
      }
      return STAGE_LABELS[over.id];
    }

    return {
      onDragStart: ({ active }) =>
        `${cardName(active.id)} aufgenommen. Mit den Pfeiltasten nach links und rechts eine ` +
        'Phase waehlen, mit der Leertaste ablegen, mit Escape abbrechen.',
      onDragOver: ({ active, over }) => {
        const stage = stageName(over);
        return stage === null
          ? `${cardName(active.id)} liegt ueber keiner Phase.`
          : `${cardName(active.id)} ueber Phase ${stage}.`;
      },
      onDragEnd: ({ active, over }) => {
        const stage = stageName(over);
        return stage === null
          ? `${cardName(active.id)} wurde nicht verschoben.`
          : `${cardName(active.id)} in Phase ${stage} abgelegt.`;
      },
      onDragCancel: ({ active }) => `Verschieben von ${cardName(active.id)} abgebrochen.`,
    };
  }, [rowsById]);

  function handleDragStart(event: DragStartEvent) {
    setActiveId(toContactId(event.active.id));
    setError(null);
  }

  function endDrag() {
    setActiveId(null);
    dragEndedAt.current = Date.now();
  }

  function handleDragEnd(event: DragEndEvent) {
    endDrag();

    const { active, over } = event;
    const id = toContactId(active.id);
    if (id === null || over === null || !isStage(over.id)) {
      return;
    }

    const target: Stage = over.id;
    const row = rowsById.get(id);
    if (row === undefined || row.stage === target) {
      return;
    }

    startTransition(async () => {
      queueMove({ id, to: target });
      const result = await setStageAction(id, target);
      if (!result.ok) {
        setError(
          `${row.name} konnte nicht nach "${STAGE_LABELS[target]}" verschoben werden: ${result.error}`,
        );
      }
    });
  }

  /**
   * Klick auf eine Karte. Der unmittelbar auf einen Zug folgende Klick wird
   * verworfen - er ist der Nachhall des Loslassens, keine Absicht.
   */
  const handleOpen = useCallback((id: number) => {
    if (Date.now() - dragEndedAt.current < CLICK_AFTER_DRAG_MS) {
      return;
    }
    setOpenId(id);
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2.5 px-4">
        <h1 className="text-md font-semibold tracking-tight text-fg">Board</h1>
        <p className="text-sm text-muted tabular-nums">
          {total === 1 ? '1 aktiver Kontakt' : `${total} aktive Kontakte`}
        </p>
        {error === null ? null : (
          <div className="ml-auto flex min-w-0 items-center gap-1">
            <InlineError className="truncate">{error}</InlineError>
            <Button
              size="icon"
              onClick={() => setError(null)}
              aria-label="Meldung schliessen"
              className="shrink-0"
            >
              <IconClose />
            </Button>
          </div>
        )}
      </div>

      <DndContext
        // Ohne feste id vergibt dnd-kit seine aria-describedby-Kennungen aus einem
        // modulweiten Zaehler. Der steht beim Server-Rendern auf einem anderen Wert
        // als im Browser, und React meldet beim Hydrieren eine Abweichung an jeder
        // Karte. useId liefert eine Kennung, die auf beiden Seiten dieselbe ist.
        id={dndContextId}
        sensors={sensors}
        collisionDetection={closestCorners}
        // Die Spalten aendern beim Verschieben ihre Hoehe; ohne staendiges
        // Nachmessen zielt vor allem die Tastaturbedienung auf veraltete
        // Rechtecke.
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        accessibility={{
          announcements,
          screenReaderInstructions: BOARD_SCREEN_READER_INSTRUCTIONS,
        }}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={endDrag}
      >
        <div className="flex min-h-0 flex-1 overflow-x-auto">
          <div className="flex min-w-max flex-1 border-t border-border px-4 pt-2">
            {STAGES.map((stage) => (
              <BoardColumn
                key={stage}
                stage={stage}
                rows={state.columns[stage]}
                pendingIds={state.pending}
                dragging={activeId !== null}
                onOpen={handleOpen}
              />
            ))}
          </div>
        </div>

        {/* Kein Rueckflug-Effekt: die Karte steht im selben Bild schon in der
            neuen Spalte, eine Animation zurueck zum Ausgangspunkt waere eine
            Bewegung, die dem Ergebnis widerspricht. */}
        <DragOverlay dropAnimation={null}>
          {activeRow === null ? null : <BoardCardPreview row={activeRow} />}
        </DragOverlay>
      </DndContext>

      {openId === null ? null : (
        <ContactDetailSheet
          contactId={openId}
          onClose={() => setOpenId(null)}
          onChanged={() => router.refresh()}
        />
      )}
    </div>
  );
}
