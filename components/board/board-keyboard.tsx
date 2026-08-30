'use client';

/**
 * Tastaturbedienung des Boards.
 *
 * Ein Kanban, das nur mit der Maus funktioniert, ist ein halbes Kanban. dnd-kit
 * bringt dafuer den KeyboardSensor mit, ueberlaesst aber zwei Entscheidungen
 * der Anwendung, und genau die stehen hier:
 *
 *   1. WELCHE TASTEN. Die Vorgabe von dnd-kit nimmt eine Karte mit Leertaste
 *      ODER Eingabetaste auf. Auf dem Board ist die Eingabetaste aber schon
 *      vergeben: sie oeffnet die Detailansicht (siehe board-card.tsx). Also
 *      bleibt zum Aufnehmen und Ablegen die Leertaste, zum Abbrechen Escape.
 *
 *   2. WOHIN DIE PFEILTASTEN FUEHREN. Die Vorgabe schiebt die Karte in
 *      25-Pixel-Schritten durch die Gegend - auf einem Board mit 264 Pixel
 *      breiten Spalten waeren das elf Tastendruecke pro Spalte. Der
 *      Koordinatengeber unten springt stattdessen von Spaltenmitte zu
 *      Spaltenmitte: ein Druck, eine Phase.
 *
 * Hoch und runter bewegen bewusst nichts. Die Reihenfolge innerhalb einer
 * Spalte ist keine gespeicherte Eigenschaft - das Board sortiert nach Namen -,
 * eine Karte "hoeher" abzulegen haette also keine Wirkung, die den Tastendruck
 * rechtfertigt. Was zaehlt, ist die Phase, und die liegt links und rechts.
 */

import { KeyboardCode } from '@dnd-kit/core';
import type {
  ClientRect,
  KeyboardCodes,
  KeyboardCoordinateGetter,
  ScreenReaderInstructions,
} from '@dnd-kit/core';

import { STAGES, type Stage } from '@/lib/constants';

/**
 * Leertaste nimmt auf und legt ab, Escape bricht ab. Die Eingabetaste ist
 * absichtlich in keiner der drei Listen: sie gehoert der Detailansicht.
 */
export const BOARD_KEYBOARD_CODES: KeyboardCodes = {
  start: [KeyboardCode.Space],
  cancel: [KeyboardCode.Esc],
  end: [KeyboardCode.Space],
};

/** Der Satz, den ein Bildschirmleser beim Fokussieren einer Karte vorliest. */
export const BOARD_SCREEN_READER_INSTRUCTIONS: ScreenReaderInstructions = {
  draggable:
    'Mit der Leertaste eine Karte aufnehmen. Danach mit den Pfeiltasten nach links und ' +
    'rechts die Phase waehlen, mit der Leertaste in der gewaehlten Phase ablegen und mit ' +
    'Escape abbrechen. Mit der Eingabetaste die Detailansicht des Kontakts oeffnen.',
};

interface Column {
  stage: Stage;
  rect: ClientRect;
}

/**
 * Die aktuell gemessenen Spalten in der Reihenfolge aus STAGES.
 *
 * Gemessen wird nur, was dnd-kit auch kennt: eine Spalte ohne registriertes
 * Rechteck (noch nicht gemessen, ausgeblendet) wird uebersprungen, damit der
 * Sprung nicht ins Leere zeigt.
 */
function measuredColumns(
  droppableRects: Map<string | number, ClientRect>,
  isEnabled: (stage: Stage) => boolean,
): Column[] {
  const columns: Column[] = [];
  for (const stage of STAGES) {
    if (!isEnabled(stage)) {
      continue;
    }
    const rect = droppableRects.get(stage);
    if (rect !== undefined) {
      columns.push({ stage, rect });
    }
  }
  return columns;
}

/** Index der Spalte, ueber der die Karte gerade liegt - die naechstgelegene Mitte. */
function currentColumnIndex(columns: readonly Column[], center: number): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  columns.forEach((column, index) => {
    const distance = Math.abs(column.rect.left + column.rect.width / 2 - center);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

/**
 * Pfeiltaste links/rechts: eine Spalte weiter.
 *
 * Der Rueckgabewert ist die neue linke obere Ecke der gezogenen Karte in
 * Fensterkoordinaten - dnd-kit rechnet daraus selbst die Verschiebung aus. Die
 * Karte wird waagerecht in der Zielspalte zentriert und behaelt ihre Hoehe;
 * void bedeutet "keine Bewegung", etwa am linken oder rechten Ende des Boards.
 */
export const boardKeyboardCoordinates: KeyboardCoordinateGetter = (event, { context }) => {
  const step =
    event.code === KeyboardCode.Right ? 1 : event.code === KeyboardCode.Left ? -1 : 0;
  if (step === 0) {
    return undefined;
  }

  const { collisionRect, droppableRects, droppableContainers } = context;
  if (collisionRect === null) {
    return undefined;
  }

  const columns = measuredColumns(droppableRects, (stage) => {
    const container = droppableContainers.get(stage);
    return container !== undefined && !container.disabled;
  });
  if (columns.length === 0) {
    return undefined;
  }

  const index = currentColumnIndex(columns, collisionRect.left + collisionRect.width / 2);
  const target = columns[index + step];
  if (target === undefined) {
    return undefined;
  }

  return {
    x: target.rect.left + Math.max(0, (target.rect.width - collisionRect.width) / 2),
    y: collisionRect.top,
  };
};
