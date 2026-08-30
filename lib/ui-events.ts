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

/**
 * Der Kontaktbestand hat sich ausserhalb der gerade sichtbaren Ansicht geaendert.
 *
 * Zweiter Eintrag aus demselben Grund wie der erste: die Kommandopalette haengt
 * im Layout, die Listenansicht in der Seite darunter. Sie sind Geschwister, es
 * gibt keinen gemeinsamen Zustand und keine Props, die von der einen zur
 * anderen fliessen koennten.
 *
 * Warum nicht router.refresh(): das Board nimmt seine Spalten direkt aus den
 * Props und wuerde davon erneuert. Die Listenansicht dagegen fuehrt ihren
 * eigenen Zustand (Filter, Sortierung, Suchbegriff) und uebernimmt initialRows
 * bewusst nur beim ersten Rendern - ein Neurendern der Serverkomponente kaeme
 * dort also gar nicht an. Sie muss ihre eigene Abfrage wiederholen, und genau
 * das loest dieses Ereignis aus.
 */
export const CONTACTS_CHANGED_EVENT = 'mutuals:contacts-changed';

/** Nach Anlegen, Aendern oder Loeschen ausserhalb der sichtbaren Ansicht. */
export function notifyContactsChanged(): void {
  if (typeof window === 'undefined') {
    return;
  }
  window.dispatchEvent(new CustomEvent(CONTACTS_CHANGED_EVENT));
}
