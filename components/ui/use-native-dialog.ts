'use client';

import { useCallback, useEffect, useRef } from 'react';

/**
 * Die Mechanik hinter Sheet und Dialog.
 *
 * Getragen wird beides vom nativen <dialog> mit showModal(). Das ist hier die
 * kuerzere UND die richtigere Loesung, denn showModal() liefert vom Browser:
 *   - eine echte Fokusfalle (der Rest des Dokuments wird inert),
 *   - Escape zum Schliessen,
 *   - Rueckgabe des Fokus an das ausloesende Element beim Schliessen,
 *   - gesperrtes Scrollen der Seite dahinter,
 *   - die Darstellung in der Top-Layer, also ohne z-index-Wettruesten.
 *
 * Von Hand nachgebaut ist genau das die Stelle, an der Slide-overs ueblicherweise
 * scheitern - deshalb wird sie nicht nachgebaut.
 *
 * Der Rueckgabewert ist bewusst schlicht: zwei Refs und ein Handler fuer das
 * native close-Event.
 */
export interface NativeDialogHandles {
  dialogRef: React.RefObject<HTMLDialogElement | null>;
  /** Bekommt tabIndex={-1} und den Startfokus, damit der Einstieg vorhersagbar ist. */
  panelRef: React.RefObject<HTMLDivElement | null>;
  /** Gehoert an onClose des <dialog>. */
  handleNativeClose: () => void;
  /** Gehoert an onKeyDown des <dialog>. */
  handleKeyDown: (event: React.KeyboardEvent<HTMLDialogElement>) => void;
  /** Gehoert an onMouseDown der Flaeche um das Panel herum. */
  handleBackdropMouseDown: (event: React.MouseEvent<HTMLElement>) => void;
}

export function useNativeDialog(open: boolean, onClose: () => void): NativeDialogHandles {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  /**
   * Spiegelt open synchron. Gebraucht, um zwei Faelle zu unterscheiden, die
   * beide dasselbe close-Event ausloesen: der Nutzer hat Escape gedrueckt (dann
   * muss die Elternkomponente ihren Zustand nachziehen) oder wir selbst haben
   * close() gerufen, weil open bereits false ist (dann waere ein weiterer
   * onClose-Aufruf eine Endlosschleife).
   */
  const openRef = useRef(open);

  useEffect(() => {
    openRef.current = open;
    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }
    if (open) {
      if (!dialog.open) {
        dialog.showModal();
        panelRef.current?.focus();
      }
      return;
    }
    if (dialog.open) {
      dialog.close();
    }
  }, [open]);

  const handleNativeClose = useCallback(() => {
    if (!openRef.current) {
      return;
    }
    openRef.current = false;
    onClose();
  }, [onClose]);

  /**
   * Escape schliesst - ausdruecklich und nicht nur ueber den Browser.
   *
   * Das native <dialog> bringt das eigentlich mit (CloseWatcher). Verlassen
   * wird sich darauf trotzdem nicht, aus zwei Gruenden:
   *
   *   1. Der Browser wuerde den Dialog von sich aus schliessen, waehrend
   *      React weiter open === true glaubt. Der Zustand liefe auseinander, und
   *      das close-Event ist die einzige Bruecke zurueck. Hier wird der
   *      Zustand zuerst gefuehrt und die Anzeige folgt.
   *   2. Die Reihenfolge waere nicht steuerbar. Ist im Sheet ein Popover
   *      offen, soll Escape ERST das Popover schliessen. Das Popover hoert
   *      dafuer in der Capture-Phase am Dokument und stoppt das Ereignis,
   *      bevor es hier ankommt - gegen den CloseWatcher des Browsers ginge das
   *      nicht.
   *
   * openRef wird sofort gesetzt, damit ein danach doch noch eintreffendes
   * natives close-Event nicht ein zweites onClose ausloest.
   */
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDialogElement>) => {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return;
      }
      event.preventDefault();
      openRef.current = false;
      onClose();
    },
    [onClose],
  );

  /**
   * Klick auf den Hintergrund schliesst. mousedown und nicht click: wer im
   * Panel eine Textauswahl beginnt und den Zeiger dabei nach draussen zieht,
   * loest sonst beim Loslassen ein click auf dem Hintergrund aus und verliert
   * seine Eingabe.
   */
  const handleBackdropMouseDown = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget) {
        return;
      }
      onClose();
    },
    [onClose],
  );

  return { dialogRef, panelRef, handleNativeClose, handleKeyDown, handleBackdropMouseDown };
}

/**
 * Grundklassen des <dialog>: volle Flaeche, kein UA-Rahmen, abgedunkelter Grund.
 *
 * h-full und w-full sind NICHT ueberfluessig neben inset-0: die
 * Browser-Standardregel fuer dialog setzt width und height auf fit-content,
 * und fit-content gewinnt gegen das Aufspannen durch die vier Insets. Ohne die
 * beiden Klassen klebt das Panel als kleiner Kasten in der linken oberen Ecke.
 */
export const DIALOG_ELEMENT_CLASS =
  'fixed inset-0 m-0 h-full max-h-none w-full max-w-none border-0 bg-transparent p-0 text-fg ' +
  'backdrop:bg-scrim';
