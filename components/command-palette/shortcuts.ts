/**
 * Die Regeln, wann ein globales Tastenkuerzel feuern darf.
 *
 * Hier steht bewusst kein React: das sind vier Fragen an das Ereignis und an
 * das Dokument, und genau deshalb lassen sie sich einzeln lesen und einzeln
 * pruefen. Die Verdrahtung liegt in components/command-palette.tsx.
 *
 * Der teuerste Fehler in dieser Ecke der Anwendung waere ein "n", das
 * waehrend des Tippens einen Kontakt anlegt. Deshalb sind es zwei voneinander
 * unabhaengige Sperren - isTypingTarget und isModalOpen -, und keine davon
 * verlaesst sich darauf, dass die andere greift.
 */

/**
 * Tippt der Nutzer gerade?
 *
 * Geprueft wird das Ziel des Ereignisses, nicht document.activeElement: bei
 * einem keydown ist das Ziel das Element, das die Taste bekommt - und das ist
 * die Frage, um die es geht. Innerhalb des Detail-Slide-overs liegen vierzehn
 * Felder; ein "n" in "Kennengelernt auf der Konferenz" darf nichts anlegen.
 *
 * isContentEditable deckt auch verschachtelte Faelle ab: die Eigenschaft ist
 * fuer jedes Element innerhalb eines contenteditable-Bereichs true, nicht nur
 * fuer das Element mit dem Attribut.
 *
 * role="textbox" steht mit in der Liste, weil ein nachgebautes Eingabefeld
 * genauso Zeichen entgegennimmt wie ein echtes - die Anwendung hat heute
 * keines, aber die Sperre soll nicht davon abhaengen, dass das so bleibt.
 *
 * Nicht in der Liste: <button> und Links. Dort tippt niemand, und die
 * Kuerzel sollen funktionieren, waehrend der Fokus auf einem Knopf steht.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    return true;
  }
  return target.getAttribute('role') === 'textbox';
}

/**
 * Liegt gerade irgendein modaler Dialog offen?
 *
 * Sheet, Dialog und damit Slide-over, Palette und Rueckfrage sind alle ein
 * natives <dialog> mit showModal() (siehe use-native-dialog.ts). Das offene
 * Attribut ist damit die eine verlaessliche Antwort auf die Frage, ob etwas
 * Modales im Weg steht - und zwar auch fuer die Slide-overs von Liste und
 * Board, die diese Datei nicht kennt.
 *
 * Solange etwas offen ist, ruhen die nackten Buchstabenkuerzel: "N" wuerde
 * sonst einen zweiten Dialog ueber den ersten legen.
 */
export function isModalOpen(): boolean {
  return document.querySelector('dialog[open]') !== null;
}

/**
 * Bittet alle offenen Dialoge, sich zu schliessen - mit einem Escape.
 *
 * Gebraucht an genau einer Stelle: die Palette oeffnet einen Kontakt,
 * waehrend Liste oder Board ihr eigenes Slide-over offen haben. Ohne das
 * laegen zwei Panels uebereinander, mit doppelt abgedunkeltem Grund und zwei
 * Escape-Druecken bis zurueck zur Anwendung.
 *
 * WARUM NICHT dialog.close(). Das waere der naheliegende Aufruf und ist
 * genau der falsche: er schliesst das Element, aber der React-Zustand der
 * besitzenden Ansicht bleibt auf "offen" stehen (das native close-Ereignis
 * kommt dort nicht an). Die Ansicht ist danach kaputt - ihr Panel laesst
 * sich nicht wieder oeffnen, weil sich ihr open-Wert nie geaendert hat.
 * Nachgemessen im Browser, nicht vermutet.
 *
 * Ein Escape dagegen nimmt denselben Weg wie der Nutzer: er landet im
 * onKeyDown des Dialogs (use-native-dialog.ts), das seinerseits onClose ruft
 * und den Zustand des Besitzers richtig nachzieht. Deshalb muss das Ereignis
 * auch blubbern - React hoert nicht am Element selbst.
 */
export function dismissOpenDialogs(): void {
  for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog[open]')) {
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }
}

/**
 * Cmd+K bzw. Strg+K.
 *
 * Alt ist ausgeschlossen, damit das Kuerzel nicht auf Tastaturlayouts feuert,
 * auf denen AltGr-Kombinationen Zeichen erzeugen. Shift bleibt erlaubt -
 * "Cmd+Shift+K" ist fuer den Nutzer dasselbe Kuerzel mit einem Finger zu
 * viel.
 */
export function isPaletteChord(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k';
}

/**
 * Ein nackter Buchstabe, ohne jede Zusatztaste.
 *
 * Ausdruecklich ohne Modifikatoren: Cmd+N oeffnet ein Browserfenster, Strg+N
 * ebenso - beides gehoert nicht der Anwendung.
 */
export function isBareKey(event: KeyboardEvent, key: string): boolean {
  return (
    !event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === key
  );
}
