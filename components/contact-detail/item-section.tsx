'use client';

import { useEffect, useRef, useState } from 'react';

import { EmptyState, IconClose, InlineError, Input, cx } from '@/components/ui';
import type { ContactItem } from '@/lib/types';

import { ConfirmInline } from './confirm-inline';
import { useInlineEdit, type SaveResult } from './inline-edit';
import { DetailSection } from './section';

/**
 * Needs und Offers.
 *
 * Beide Bloecke sind bis auf die Beschriftung derselbe Block: dieselben
 * Spalten in der Datenbank, dieselben Handgriffe. Zwei Abschriften davon
 * wuerden ab dem ersten Tag auseinanderlaufen.
 *
 * ERLEDIGT HEISST DURCHGESTRICHEN, NICHT WEG. Ein Need, den man verkuppelt
 * hat, ist der wertvollste Eintrag im ganzen Datensatz - er belegt, dass es
 * funktioniert hat. Der Klick setzt deshalb resolved_at und loescht nichts;
 * gestrichene Eintraege rutschen nach unten und bleiben lesbar.
 */

/**
 * Wie lange ein Klick auf den Doppelklick wartet.
 *
 * Klick schaltet erledigt um, Doppelklick bearbeitet den Text - das sind zwei
 * Bedeutungen auf demselben Ziel, und der erste Klick eines Doppelklicks ist
 * von einem einfachen Klick nicht zu unterscheiden. Also wartet das Umschalten
 * die uebliche Doppelklickspanne ab. Der Preis ist eine viertel Sekunde bis
 * zum Durchstreichen; die Alternative - sofort umschalten und beim
 * Doppelklick wieder zurueck - waere ein sichtbares Flackern und zwei
 * Schreibvorgaenge fuer eine Absicht.
 */
const DOUBLE_CLICK_MS = 250;

export interface ItemSectionProps {
  title: string;
  items: readonly ContactItem[];
  /** Einzahl fuer Beschriftungen und Rueckfragen, z.B. "Need". */
  noun: string;
  emptyTitle: string;
  addPlaceholder: string;
  onAdd: (text: string) => SaveResult;
  onToggle: (item: ContactItem) => SaveResult;
  onEditText: (item: ContactItem, text: string) => SaveResult;
  onDelete: (item: ContactItem) => SaveResult;
}

export function ItemSection({
  title,
  items,
  noun,
  emptyTitle,
  addPlaceholder,
  onAdd,
  onToggle,
  onEditText,
  onDelete,
}: ItemSectionProps) {
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    const text = draft.trim();
    if (text === '' || adding) {
      return;
    }
    setAdding(true);
    const message = await onAdd(text);
    setAdding(false);
    setError(message);
    if (message === null) {
      setDraft('');
    }
  }

  return (
    <DetailSection title={title} count={items.length}>
      <Input
        value={draft}
        placeholder={addPlaceholder}
        aria-label={`${noun} hinzufuegen`}
        aria-invalid={error !== null}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            void submit();
            return;
          }
          // Escape verwirft zuerst die angefangene Eingabe. Erst ein leeres
          // Feld laesst Escape weiter nach oben und schliesst das Slide-over.
          if (event.key === 'Escape' && draft !== '') {
            event.preventDefault();
            event.stopPropagation();
            setDraft('');
            setError(null);
          }
        }}
      />
      <InlineError className="pt-1">{error}</InlineError>

      {items.length === 0 ? (
        <EmptyState title={emptyTitle} />
      ) : (
        <ul className="pt-1.5">
          {items.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              noun={noun}
              onToggle={onToggle}
              onEditText={onEditText}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </DetailSection>
  );
}

interface ItemRowProps {
  item: ContactItem;
  noun: string;
  onToggle: (item: ContactItem) => SaveResult;
  onEditText: (item: ContactItem, text: string) => SaveResult;
  onDelete: (item: ContactItem) => SaveResult;
}

function ItemRow({ item, noun, onToggle, onEditText, onDelete }: ItemRowProps) {
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readRef = useRef<HTMLButtonElement>(null);

  const resolved = item.resolved_at !== null;

  const edit = useInlineEdit({
    value: item.text,
    multiline: false,
    selectOnEdit: true,
    readRef,
    onSave: async (next) => {
      // Ein leergeraeumter Eintrag ist kein Loeschbefehl: dafuer gibt es das
      // Kreuz und die Rueckfrage daneben.
      if (next === null) {
        return `Der Text eines ${noun}s darf nicht leer sein.`;
      }
      return onEditText(item, next);
    },
  });

  useEffect(() => {
    return () => {
      if (clickTimer.current !== null) {
        clearTimeout(clickTimer.current);
      }
    };
  }, []);

  function handleClick(): void {
    if (clickTimer.current !== null) {
      return;
    }
    clickTimer.current = setTimeout(() => {
      clickTimer.current = null;
      void onToggle(item).then(setError);
    }, DOUBLE_CLICK_MS);
  }

  function handleDoubleClick(): void {
    if (clickTimer.current !== null) {
      clearTimeout(clickTimer.current);
      clickTimer.current = null;
    }
    edit.start();
  }

  async function remove(): Promise<void> {
    setDeleting(true);
    const message = await onDelete(item);
    setDeleting(false);
    setConfirming(false);
    setError(message);
  }

  const text = edit.shown ?? item.text;

  return (
    <li className="group/item">
      {edit.editing ? (
        <Input
          ref={edit.ref}
          value={edit.draft}
          aria-label={`${noun} bearbeiten`}
          aria-invalid={edit.error !== null}
          onChange={(event) => edit.setDraft(event.target.value)}
          onKeyDown={edit.handleKeyDown}
          onBlur={edit.handleBlur}
        />
      ) : (
        <div className="flex items-start gap-1">
          <button
            type="button"
            ref={readRef}
            onClick={handleClick}
            onDoubleClick={handleDoubleClick}
            onKeyDown={(event) => {
              // F2 ist der Weg zum Bearbeiten ohne Maus - ein Doppelklick
              // laesst sich mit der Tastatur nicht ausloesen.
              if (event.key === 'F2') {
                event.preventDefault();
                event.stopPropagation();
                edit.start();
              }
            }}
            aria-pressed={resolved}
            aria-keyshortcuts="F2"
            title={
              resolved
                ? 'Klick nimmt die Erledigung zurueck, Doppelklick bearbeitet den Text'
                : 'Klick markiert als erledigt, Doppelklick bearbeitet den Text'
            }
            className={cx(
              'min-w-0 flex-1 rounded-sm border border-transparent px-1.5 py-0.5 text-left',
              'transition-colors duration-75 hover:border-border hover:bg-surface',
              edit.saving && 'text-muted',
            )}
          >
            <span
              className={cx(
                'block break-words',
                resolved ? 'text-faint line-through' : 'text-fg',
                edit.saving && 'text-muted',
              )}
            >
              {text}
            </span>
          </button>

          {confirming ? null : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              aria-label={`${noun} "${item.text}" loeschen`}
              className={cx(
                'mt-1 inline-flex size-4 shrink-0 items-center justify-center rounded-xs',
                'text-faint opacity-0 transition-opacity duration-75',
                'hover:bg-surface-sunken hover:text-fg focus-visible:opacity-100',
                'group-hover/item:opacity-100 group-focus-within/item:opacity-100',
              )}
            >
              <IconClose width="11" height="11" />
            </button>
          )}
        </div>
      )}

      {confirming ? (
        <ConfirmInline
          question={`${noun} loeschen?`}
          confirmLabel="Loeschen"
          pending={deleting}
          onConfirm={() => void remove()}
          onCancel={() => setConfirming(false)}
          className="py-1 pl-1.5"
        />
      ) : null}

      <InlineError className="pl-1.5">{edit.error ?? error}</InlineError>
    </li>
  );
}
