'use client';

import { useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';

import { Button, Spinner, cx } from '@/components/ui';

/**
 * Die Ablageflaeche fuer die Importdatei.
 *
 * Ziehen und Ablegen ist der bequeme Weg, der Knopf daneben der verlaessliche:
 * mit der Tastatur, mit einem Screenreader und in jedem Browser, dessen
 * Drag-and-Drop gerade nicht mitspielt, fuehrt der Knopf zum selben Ziel. Das
 * Eingabefeld dahinter ist versteckt (hidden, nicht sr-only) - sichtbar fuer
 * Hilfsmittel waere es ein zweiter Tabstopp fuer dieselbe Handlung.
 *
 * Geprueft wird schon hier, vor dem ersten Netzzugriff: Endung, leere Datei,
 * Groesse. Dieselben Grenzen prueft app/actions.ts noch einmal - der Browser
 * ist keine Zusicherung. Der Sinn dieser Runde ist die Antwortzeit: wer eine
 * .pdf ablegt, soll das sofort lesen und nicht nach einem Upload.
 */

/** Dieselben Endungen wie in app/actions.ts und lib/import/parse.ts. */
const EXTENSIONS = ['.csv', '.xlsx', '.xls'] as const;
const ACCEPT = EXTENSIONS.join(',');

/** Dieselbe Grenze wie MAX_UPLOAD_BYTES in app/actions.ts. */
const MAX_BYTES = 20 * 1024 * 1024;

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot).toLowerCase();
}

/** Warum diese Datei nicht in Frage kommt - oder null, wenn sie taugt. */
function rejectReason(file: File): string | null {
  const extension = extensionOf(file.name);
  if (!(EXTENSIONS as readonly string[]).includes(extension)) {
    return extension === ''
      ? `"${file.name}" hat keine Dateiendung. Eingelesen werden .csv, .xlsx und .xls.`
      : `Dateien mit der Endung "${extension}" koennen nicht gelesen werden. ` +
          'Eingelesen werden .csv, .xlsx und .xls.';
  }
  if (file.size === 0) {
    return `"${file.name}" ist leer - die Datei enthaelt kein einziges Byte.`;
  }
  if (file.size > MAX_BYTES) {
    return `"${file.name}" ist groesser als 20 MB und wird nicht eingelesen.`;
  }
  return null;
}

export interface DropZoneProps {
  onFile: (file: File) => void;
  /** Abgelehnte Datei: die Meldung geht nach oben, angezeigt wird sie dort. */
  onReject: (message: string) => void;
  /** Waehrend Parsen und Import gesperrt, damit die Datei nicht mitten im Lauf wechselt. */
  disabled: boolean;
  /** true, waehrend die Vorschau geholt wird. */
  busy: boolean;
}

export function DropZone({ onFile, onReject, disabled, busy }: DropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  /**
   * Zaehler statt eines Wahrheitswerts: dragleave feuert auch beim Uebergang
   * auf ein Kindelement. Mit einem blossen setDragging(false) flackerte die
   * Hervorhebung, sobald der Zeiger die Ueberschrift in der Flaeche kreuzt.
   */
  const depth = useRef(0);

  /**
   * Eine Datei, die neben der Ablageflaeche landet, oeffnet der Browser sonst
   * einfach - die Seite ist weg, samt gewaehlter Datei und Zuordnung. Beides
   * abzufangen kostet zwei Zeilen und rettet den Zwischenstand.
   */
  useEffect(() => {
    const prevent = (event: globalThis.DragEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  function take(files: readonly File[]): void {
    const [first, ...rest] = files;
    if (first === undefined) {
      onReject('In der Ablage war keine Datei. Bitte noch einmal versuchen.');
      return;
    }
    if (rest.length > 0) {
      onReject('Es wird eine Datei auf einmal eingelesen. Bitte einzeln ablegen.');
      return;
    }
    const problem = rejectReason(first);
    if (problem !== null) {
      onReject(problem);
      return;
    }
    onFile(first);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    depth.current = 0;
    setDragging(false);
    if (disabled) {
      return;
    }
    take(Array.from(event.dataTransfer.files));
  }

  function handleDragEnter(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    if (disabled) {
      return;
    }
    depth.current += 1;
    setDragging(true);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>): void {
    // Ohne preventDefault auf dragover nimmt der Browser die Ablage nicht an -
    // drop wird dann nie ausgeloest.
    event.preventDefault();
    if (!disabled) {
      event.dataTransfer.dropEffect = 'copy';
    }
  }

  function handleDragLeave(): void {
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) {
      setDragging(false);
    }
  }

  function handleChange(event: ChangeEvent<HTMLInputElement>): void {
    take(Array.from(event.target.files ?? []));
    // Zuruecksetzen, damit dieselbe Datei ein zweites Mal ausgewaehlt werden
    // kann - ohne das bleibt der Wert gleich und change feuert nicht mehr.
    event.target.value = '';
  }

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cx(
        'flex flex-col items-center justify-center gap-2 rounded-md border border-dashed',
        'px-6 py-10 text-center transition-colors duration-75',
        dragging ? 'border-accent bg-accent-soft' : 'border-border-strong bg-surface',
        disabled && 'opacity-45',
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        onChange={handleChange}
        hidden
        tabIndex={-1}
      />

      {busy ? (
        <p className="flex items-center gap-2 text-base text-muted">
          <Spinner />
          Die Datei wird gelesen.
        </p>
      ) : (
        <>
          <p className="text-base text-fg">
            {dragging ? 'Jetzt loslassen.' : 'Datei hierher ziehen.'}
          </p>
          <Button
            variant="outline"
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            Datei auswaehlen
          </Button>
        </>
      )}

      <p className="text-sm text-muted">
        CSV oder Excel (.csv, .xlsx, .xls), hoechstens 20 MB. Ein LinkedIn-Export wird mit
        seiner Praeambel erkannt.
      </p>
    </div>
  );
}
