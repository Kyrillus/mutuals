'use client';

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

import { Input, InlineError, Select, Textarea, cx } from '@/components/ui';

/**
 * Das Bearbeiten an Ort und Stelle.
 *
 * Ein Feld hat drei Zustaende und keinen vierten: es zeigt seinen Wert, es
 * wird bearbeitet, oder der geaenderte Wert ist unterwegs zum Server. Der
 * dritte Zustand ist der interessante - dort steht bereits der NEUE Wert,
 * gedaempft. Kein Spinner an seiner Stelle: die Anzeige eines Werts durch ein
 * Ladesymbol zu ersetzen nimmt genau die Information weg, um die es gerade
 * geht, und laesst die Zeile ausserdem springen.
 *
 * Schlaegt das Speichern fehl, wird nichts zurueckgerechnet: der neue Wert war
 * nur eine Anzeige, die Wahrheit steht weiter in den Daten von oben. Es
 * genuegt, die Anzeige fallen zu lassen und die Meldung ans Feld zu haengen.
 *
 * ESCAPE MUSS HIER STOPPEN. Das Feld liegt in einem Slide-over, und dessen
 * Escape schliesst das ganze Panel. Wer beim Korrigieren eines Tippfehlers
 * abbricht, will das Feld verlassen und nicht die Detailansicht. Deshalb
 * beendet jeder Tastendruck, den dieses Feld selbst behandelt, seine Reise mit
 * preventDefault und stopPropagation.
 */

/** Speichern: gibt eine anzeigbare Meldung zurueck - oder null, wenn es geklappt hat. */
export type SaveResult = Promise<string | null>;

interface UseInlineEditOptions {
  /** Der gespeicherte Wert. null heisst "nicht hinterlegt". */
  value: string | null;
  onSave: (next: string | null) => SaveResult;
  /** Mehrzeilig: Enter macht dann einen Absatz statt zu speichern. */
  multiline: boolean;
  /** Nach dem Oeffnen den Inhalt markieren. Bei Datumsfeldern sinnlos. */
  selectOnEdit: boolean;
  /**
   * Das Bedienelement des Ruhezustands. Nach Enter und Escape geht der Fokus
   * dorthin zurueck - das Eingabefeld verschwindet dabei, und ein Fokus, der
   * ins Nichts faellt, laesst Tab wieder von vorn beginnen.
   */
  readRef: React.RefObject<HTMLButtonElement | null>;
}

interface InlineEditState {
  editing: boolean;
  draft: string;
  setDraft: (value: string) => void;
  /** Was angezeigt werden soll - waehrend des Speicherns der neue Wert. */
  shown: string | null;
  saving: boolean;
  error: string | null;
  start: () => void;
  /**
   * Rueckruf-Ref statt Objekt-Ref: dasselbe Feld ist mal ein input und mal ein
   * textarea, und eine Objekt-Ref liesse sich nicht auf beide Typen legen,
   * ohne zu casten.
   */
  ref: (node: HTMLInputElement | HTMLTextAreaElement | null) => void;
  handleKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  handleBlur: () => void;
}

export function useInlineEdit({
  value,
  onSave,
  multiline,
  selectOnEdit,
  readRef,
}: UseInlineEditOptions): InlineEditState {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<{ value: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  /**
   * Verhindert das doppelte Speichern. Enter und Escape nehmen das Feld aus
   * dem Baum; ob der Browser dabei noch ein blur schickt, ist von Fall zu Fall
   * verschieden - mit dieser Marke ist es egal.
   */
  const handled = useRef(false);
  const node = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  /**
   * Nur der Ausstieg per Tastatur holt den Fokus zurueck. Wer das Feld durch
   * einen Klick woanders hin verlaesst, ist dort schon angekommen und soll
   * nicht zurueckgerissen werden.
   */
  const returnFocus = useRef(false);

  useEffect(() => {
    if (editing) {
      const field = node.current;
      if (field === null) {
        return;
      }
      field.focus();
      // select() ist bei einem Datumsfeld ohne Wirkung und in aelteren Browsern
      // sogar ein Fehler - dort wird nur fokussiert.
      if (selectOnEdit) {
        field.select();
      }
      return;
    }
    if (!returnFocus.current) {
      return;
    }
    returnFocus.current = false;
    readRef.current?.focus();
  }, [editing, selectOnEdit, readRef]);

  function start(): void {
    handled.current = false;
    // Der angezeigte und nicht der gespeicherte Wert: wird gerade noch
    // gespeichert, steht im Feld schon der neue - und genau den will
    // weiterbearbeiten, wer ihn anklickt.
    setDraft((pending === null ? value : pending.value) ?? '');
    setError(null);
    setEditing(true);
  }

  function stop(): void {
    handled.current = true;
    setEditing(false);
  }

  async function commit(raw: string): Promise<void> {
    const trimmed = raw.trim();
    const next = trimmed === '' ? null : trimmed;
    stop();

    // Nichts geaendert heisst nichts schreiben: ein Klick ins Feld und wieder
    // heraus soll keine Aenderung erzeugen und updated_at nicht bewegen.
    if (next === value) {
      setError(null);
      return;
    }

    setError(null);
    setPending({ value: next });
    const message = await onSave(next);
    setPending(null);
    setError(message);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      returnFocus.current = true;
      stop();
      setError(null);
      return;
    }
    if (event.key !== 'Enter') {
      return;
    }
    // Mehrzeilig speichert mit Cmd/Strg+Enter; ein blankes Enter gehoert dort
    // dem Absatz.
    if (multiline && !(event.metaKey || event.ctrlKey)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    returnFocus.current = true;
    void commit(draft);
  }

  function handleBlur(): void {
    if (handled.current) {
      handled.current = false;
      return;
    }
    void commit(draft);
  }

  return {
    editing,
    draft,
    setDraft,
    shown: pending === null ? value : pending.value,
    saving: pending !== null,
    error,
    start,
    ref: (field) => {
      node.current = field;
    },
    handleKeyDown,
    handleBlur,
  };
}

/**
 * Ruhezustand: der Wert als Knopf, der beim Klick zum Eingabefeld wird.
 *
 * block und nicht die Vorgabe inline-block: ein inline-block steht auf der
 * Grundlinie seiner Zeile und schleppt darunter den Platz fuer Unterlaengen
 * mit. Die Zeile waere damit vier Pixel hoeher als das gleich hohe
 * Eingabefeld, und beim Anklicken ruckte die halbe Ansicht nach oben.
 */
const READ_CLASS =
  'block w-full rounded-sm border border-transparent px-2 text-left transition-colors duration-75 ' +
  'hover:border-border hover:bg-surface';

export interface InlineTextProps {
  label: string;
  value: string | null;
  onSave: (next: string | null) => SaveResult;
  /** Steht gedaempft im Feld, solange nichts hinterlegt ist. Ein ganzer Ausdruck. */
  placeholder: string;
  /** Darstellung des Werts im Ruhezustand, z.B. als deutsches Datum. */
  format?: (value: string) => string;
  hint?: string;
  multiline?: boolean;
  type?: 'text' | 'email' | 'tel' | 'url' | 'date';
}

/**
 * Eine Zeile aus Beschriftung und Wert.
 *
 * Zwei feste Spalten und nicht zwei uebereinander liegende Zeilen: so stehen
 * alle Werte des Kontakts an derselben Kante und lassen sich von oben nach
 * unten lesen, ohne dass das Auge springt.
 */
export function InlineText({
  label,
  value,
  onSave,
  placeholder,
  format,
  hint,
  multiline = false,
  type = 'text',
}: InlineTextProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const controlId = `${id}-control`;
  const readRef = useRef<HTMLButtonElement>(null);

  const edit = useInlineEdit({
    value,
    onSave,
    multiline,
    selectOnEdit: type !== 'date',
    readRef,
  });

  const text = edit.shown === null ? null : (format?.(edit.shown) ?? edit.shown);

  return (
    <div className="grid grid-cols-[104px_minmax(0,1fr)] items-start gap-x-2 py-0.5">
      <span id={labelId} className="pt-1 text-sm text-muted">
        {label}
      </span>

      <div className="min-w-0">
        {edit.editing ? (
          multiline ? (
            <Textarea
              id={controlId}
              ref={edit.ref}
              rows={3}
              value={edit.draft}
              aria-labelledby={labelId}
              aria-invalid={edit.error !== null}
              onChange={(event) => edit.setDraft(event.target.value)}
              onKeyDown={edit.handleKeyDown}
              onBlur={edit.handleBlur}
            />
          ) : (
            <Input
              id={controlId}
              ref={edit.ref}
              type={type}
              value={edit.draft}
              aria-labelledby={labelId}
              aria-invalid={edit.error !== null}
              onChange={(event) => edit.setDraft(event.target.value)}
              onKeyDown={edit.handleKeyDown}
              onBlur={edit.handleBlur}
            />
          )
        ) : (
          <button
            type="button"
            id={controlId}
            ref={readRef}
            aria-labelledby={`${labelId} ${controlId}`}
            onClick={edit.start}
            className={cx(
              READ_CLASS,
              multiline ? 'py-1' : 'h-7 leading-7',
              edit.saving && 'text-muted',
            )}
          >
            <span
              className={cx(
                'block',
                multiline ? 'whitespace-pre-wrap' : 'truncate',
                text === null && 'text-faint',
              )}
            >
              {text ?? placeholder}
            </span>
          </button>
        )}

        {hint === undefined || !edit.editing ? null : (
          <p className="px-2 pt-0.5 text-sm text-faint">{hint}</p>
        )}
        <InlineError className="px-2 pt-0.5">{edit.error}</InlineError>
      </div>
    </div>
  );
}

export interface InlineHeadingProps {
  label: string;
  value: string;
  onSave: (next: string | null) => SaveResult;
}

/**
 * Der Name im Kopf der Detailansicht.
 *
 * Dieselbe Mechanik wie eine Feldzeile, nur ohne Beschriftungsspalte und eine
 * Stufe groesser - der Name ist die Ueberschrift des Panels und zugleich ein
 * Pflichtfeld, das sich bearbeiten laesst.
 */
export function InlineHeading({ label, value, onSave }: InlineHeadingProps) {
  const id = useId();
  const readRef = useRef<HTMLButtonElement>(null);
  const edit = useInlineEdit({ value, onSave, multiline: false, selectOnEdit: true, readRef });

  return (
    <div>
      {edit.editing ? (
        <Input
          id={id}
          ref={edit.ref}
          value={edit.draft}
          aria-label={label}
          aria-invalid={edit.error !== null}
          onChange={(event) => edit.setDraft(event.target.value)}
          onKeyDown={edit.handleKeyDown}
          onBlur={edit.handleBlur}
          className="font-semibold"
        />
      ) : (
        <button
          type="button"
          ref={readRef}
          onClick={edit.start}
          aria-label={`${label}: ${edit.shown ?? value}`}
          className={cx(
            READ_CLASS,
            'h-7 truncate text-lg leading-7 font-semibold tracking-tight',
            edit.saving ? 'text-muted' : 'text-fg',
          )}
        >
          {edit.shown ?? value}
        </button>
      )}
      <InlineError className="px-2 pt-0.5">{edit.error}</InlineError>
    </div>
  );
}

export interface InlineSelectOption {
  value: string;
  label: string;
}

export interface InlineSelectProps {
  label: string;
  value: string | null;
  options: readonly InlineSelectOption[];
  onSave: (next: string | null) => SaveResult;
  /** Zeile fuer "kein Wert". Fehlt sie, ist das Feld ein Pflichtfeld. */
  emptyLabel?: string;
  placeholder: string;
}

/**
 * Auswahlfeld an Ort und Stelle.
 *
 * Im Ruhezustand steht dort nur das deutsche Wort - kein Rahmen, kein Pfeil,
 * kein Feld. Erst der Klick macht daraus das native Auswahlfeld, das sich
 * sofort oeffnet. Eine Ansicht, in der vierzehn Werte in vierzehn sichtbaren
 * Bedienelementen stehen, liest sich wie ein Formular; hier soll ein Datensatz
 * stehen, an dem man etwas aendern kann.
 */
export function InlineSelect({
  label,
  value,
  options,
  onSave,
  emptyLabel,
  placeholder,
}: InlineSelectProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const controlId = `${id}-control`;

  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState<{ value: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLSelectElement>(null);
  const readRef = useRef<HTMLButtonElement>(null);

  /** Wie bei den Textfeldern: nach dem Auswaehlen liegt der Fokus wieder am Wert. */
  const returnFocus = useRef(false);

  useEffect(() => {
    if (editing) {
      ref.current?.focus();
      return;
    }
    if (!returnFocus.current) {
      return;
    }
    returnFocus.current = false;
    readRef.current?.focus();
  }, [editing]);

  const shown = pending === null ? value : pending.value;
  const current = options.find((option) => option.value === shown) ?? null;

  async function commit(raw: string): Promise<void> {
    const next = raw === '' ? null : raw;
    returnFocus.current = true;
    setEditing(false);
    if (next === value) {
      return;
    }
    setError(null);
    setPending({ value: next });
    const message = await onSave(next);
    setPending(null);
    setError(message);
  }

  return (
    <div className="grid grid-cols-[104px_minmax(0,1fr)] items-start gap-x-2 py-0.5">
      <span id={labelId} className="pt-1 text-sm text-muted">
        {label}
      </span>

      <div className="min-w-0">
        {editing ? (
          <Select
            id={controlId}
            ref={ref}
            value={shown ?? ''}
            aria-labelledby={labelId}
            aria-invalid={error !== null}
            onChange={(event) => void commit(event.target.value)}
            onBlur={() => setEditing(false)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                returnFocus.current = true;
                setEditing(false);
              }
            }}
          >
            {emptyLabel === undefined ? null : <option value="">{emptyLabel}</option>}
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        ) : (
          <button
            type="button"
            id={controlId}
            ref={readRef}
            aria-labelledby={`${labelId} ${controlId}`}
            onClick={() => setEditing(true)}
            className={cx(READ_CLASS, 'h-7 leading-7', pending !== null && 'text-muted')}
          >
            <span className={cx('block truncate', current === null && 'text-faint')}>
              {current?.label ?? placeholder}
            </span>
          </button>
        )}
        <InlineError className="px-2 pt-0.5">{error}</InlineError>
      </div>
    </div>
  );
}
