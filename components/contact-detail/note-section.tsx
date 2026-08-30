'use client';

import { useState } from 'react';

import { Button, EmptyState, IconClose, INPUT_CLASS, InlineError, Textarea, cx } from '@/components/ui';
import { formatDate, todayIsoDate } from '@/lib/format';
import type { Note } from '@/lib/types';

import { ConfirmInline } from './confirm-inline';
import { DetailSection } from './section';
import type { SaveResult } from './inline-edit';

/**
 * Notizen - die private Schicht.
 *
 * Sie stehen bewusst nicht im Volltextindex und tauchen deshalb in keiner
 * Suche, in keiner Listenzeile und in keiner Board-Karte auf. Sie sind hier zu
 * sehen und sonst nirgends; das ist keine Nachlaessigkeit im Aufbau, sondern
 * die Zusage, die die Anwendung ihrem einzigen Nutzer gibt.
 *
 * Deshalb gibt es hier auch keine Suche ueber Notizen und keine Vorschau, die
 * einen Notizanfang irgendwo anders hinschreibt.
 *
 * Eine Notiz laesst sich anlegen und loeschen, aber nicht bearbeiten: sie ist
 * die Aufzeichnung eines Gespraechs an einem Tag, kein Feld, das man
 * fortschreibt. Was sich geaendert hat, wird zur naechsten Notiz.
 */
export interface NoteSectionProps {
  notes: readonly Note[];
  onAdd: (body: string, occurredOn: string) => SaveResult;
  onDelete: (note: Note) => SaveResult;
}

export function NoteSection({ notes, onAdd, onDelete }: NoteSectionProps) {
  const [body, setBody] = useState('');
  const [day, setDay] = useState(() => todayIsoDate());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    const text = body.trim();
    if (text === '' || pending) {
      return;
    }
    setPending(true);
    const message = await onAdd(text, day);
    setPending(false);
    setError(message);
    if (message === null) {
      setBody('');
      setDay(todayIsoDate());
    }
  }

  return (
    <DetailSection title="Notizen" count={notes.length}>
      <Textarea
        rows={2}
        value={body}
        placeholder="Was war, was besprochen wurde"
        aria-label="Neue Notiz"
        aria-invalid={error !== null}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          // Enter macht hier einen Absatz - eine Notiz ist mehrzeilig gedacht.
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            event.stopPropagation();
            void submit();
            return;
          }
          if (event.key === 'Escape' && body !== '') {
            event.preventDefault();
            event.stopPropagation();
            setBody('');
            setError(null);
          }
        }}
      />

      <div className="flex items-center gap-2 pt-1.5">
        {/* Die Breite steht am Rahmen und nicht am Feld: INPUT_CLASS bringt
            w-full mit, und eine dagegen gesetzte Breitenklasse gewinnt nicht
            zuverlaessig - siehe den Hinweis in components/ui/cx.ts. */}
        <div className="w-36 shrink-0">
          <input
            type="date"
            value={day}
            aria-label="Datum der Notiz"
            onChange={(event) => setDay(event.target.value)}
            className={INPUT_CLASS}
          />
        </div>
        <Button variant="outline" loading={pending} onClick={() => void submit()}>
          Notiz hinzufuegen
        </Button>
      </div>
      <InlineError className="pt-1">{error}</InlineError>

      {notes.length === 0 ? (
        <EmptyState
          title="Noch keine Notizen erfasst."
          description="Notizen bleiben in dieser Ansicht - sie stehen in keiner Suche und in keiner Liste."
        />
      ) : (
        <ul className="pt-2">
          {notes.map((note) => (
            <NoteRow key={note.id} note={note} onDelete={onDelete} />
          ))}
        </ul>
      )}
    </DetailSection>
  );
}

function NoteRow({ note, onDelete }: { note: Note; onDelete: (note: Note) => SaveResult }) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove(): Promise<void> {
    setPending(true);
    const message = await onDelete(note);
    setPending(false);
    setConfirming(false);
    setError(message);
  }

  return (
    <li className="group/note border-t border-border py-2 first:border-t-0 first:pt-0">
      <div className="flex items-baseline gap-2">
        <span className="text-sm text-faint tabular-nums">
          {formatDate(note.occurred_on, 'ohne Datum')}
        </span>
        {confirming ? null : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            aria-label={`Notiz vom ${formatDate(note.occurred_on, 'ohne Datum')} loeschen`}
            className={cx(
              'ml-auto inline-flex size-4 shrink-0 items-center justify-center rounded-xs',
              'text-faint opacity-0 transition-opacity duration-75',
              'hover:bg-surface-sunken hover:text-fg focus-visible:opacity-100',
              'group-hover/note:opacity-100 group-focus-within/note:opacity-100',
            )}
          >
            <IconClose width="11" height="11" />
          </button>
        )}
      </div>

      <p className="whitespace-pre-wrap text-base break-words text-fg">{note.body}</p>

      {confirming ? (
        <ConfirmInline
          question="Notiz loeschen?"
          confirmLabel="Loeschen"
          pending={pending}
          onConfirm={() => void remove()}
          onCancel={() => setConfirming(false)}
          className="pt-1"
        />
      ) : null}

      <InlineError>{error}</InlineError>
    </li>
  );
}
