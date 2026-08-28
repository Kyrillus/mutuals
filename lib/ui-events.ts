/**
 * Ereignisse zwischen Teilen der Oberflaeche, die nichts voneinander wissen.
 *
 * Konkret einer: der Hinweis in der Kopfzeile soll die Kommandopalette oeffnen,
 * beide leben aber in verschiedenen Teilbaeumen und haben keinen gemeinsamen
 * Zustand. Ein Kontext waere hier die groessere Kopplung - der Hinweis muesste
 * dann wissen, welchen Provider die Palette anbietet, und die Palette waere
 * beim Rendern der Kopfzeile Pflicht.
 *
 * Bewusst KEIN allgemeiner Ereignisbus: das hier ist eine Liste mit einem
 * Eintrag, und sie soll kurz bleiben.
 */

/** Oeffnet die Kommandopalette. Ohne Detail-Nutzlast. */
export const COMMAND_PALETTE_EVENT = 'mutuals:open-command-palette';

/** Vom Hinweis in der Kopfzeile gerufen. Im Server-Rendering ein No-Op. */
export function openCommandPalette(): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(new CustomEvent(COMMAND_PALETTE_EVENT));
}
