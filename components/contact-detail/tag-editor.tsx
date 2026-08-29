'use client';

import { useId, useRef, useState } from 'react';

import { searchTagsAction } from '@/app/actions';
import { Badge, INPUT_CLASS, InlineError, Popover, PopoverItem, cx } from '@/components/ui';
import type { Tag } from '@/lib/types';

import { DetailSection } from './section';
import type { SaveResult } from './inline-edit';

/**
 * Tags als Chips.
 *
 * NEUTRAL gefaerbt, ohne Ausnahme. Tags sind die Achse, an der ein CRM bunt
 * wird: erst bekommt "kunde" eine Farbe, dann braucht "investor" auch eine,
 * und am Ende leuchtet die Liste und sagt nichts mehr. Die Unterscheidung
 * leistet das Wort.
 *
 * Die Vorschlaege kommen aus searchTagsAction, also aus der Datenbank und
 * nicht aus einer im Browser gehaltenen Liste - ein Tag, der in einer anderen
 * Ansicht entstanden ist, steht damit sofort zur Verfuegung. Was nicht in den
 * Vorschlaegen steht, wird beim Bestaetigen angelegt; das ist der Normalfall
 * beim ersten Mal und braucht keinen eigenen Knopf.
 */
export interface TagEditorProps {
  tags: readonly Tag[];
  onAdd: (name: string) => SaveResult;
  onRemove: (tag: Tag) => SaveResult;
}

export function TagEditor({ tags, onAdd, onRemove }: TagEditorProps) {
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<readonly Tag[]>([]);
  const [active, setActive] = useState(-1);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  /**
   * Laufende Nummer der Vorschlagsabfragen. Dieselbe Vorkehrung wie in der
   * Listenansicht: beim schnellen Tippen laufen mehrere Abfragen, und die
   * Antwort auf "be" darf die auf "ber" nicht ueberschreiben.
   */
  const request = useRef(0);

  const taken = new Set(tags.map((tag) => tag.name.toLocaleLowerCase('de-DE')));

  function load(prefix: string): void {
    const seq = request.current + 1;
    request.current = seq;
    void searchTagsAction(prefix).then((result) => {
      if (seq !== request.current || !result.ok) {
        return;
      }
      setSuggestions(result.data.filter((tag) => !taken.has(tag.name.toLocaleLowerCase('de-DE'))));
      setActive(-1);
    });
  }

  async function add(name: string): Promise<void> {
    const trimmed = name.trim();
    if (trimmed === '' || pending) {
      return;
    }
    setPending(true);
    const message = await onAdd(trimmed);
    setPending(false);
    setError(message);
    if (message === null) {
      setDraft('');
      setSuggestions([]);
      setOpen(false);
    }
    inputRef.current?.focus();
  }

  const visible = open && suggestions.length > 0;

  return (
    <DetailSection title="Tags" count={tags.length}>
      <div className="flex flex-wrap items-center gap-1">
        {tags.map((tag) => (
          <Badge
            key={tag.id}
            removeLabel={`Tag "${tag.name}" entfernen`}
            onRemove={() => void onRemove(tag).then(setError)}
          >
            {tag.name}
          </Badge>
        ))}

        <div className="relative w-40">
          <input
            ref={inputRef}
            value={draft}
            placeholder={tags.length === 0 ? 'Tag hinzufuegen' : 'Tag'}
            aria-label="Tag hinzufuegen"
            aria-invalid={error !== null}
            aria-expanded={visible}
            aria-autocomplete="list"
            role="combobox"
            aria-controls={listId}
            onFocus={() => {
              setOpen(true);
              load(draft);
            }}
            onChange={(event) => {
              setDraft(event.target.value);
              setOpen(true);
              load(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                const picked = active >= 0 ? suggestions[active] : undefined;
                void add(picked?.name ?? draft);
                return;
              }
              if (event.key === 'ArrowDown' && visible) {
                event.preventDefault();
                setActive((index) => (index + 1) % suggestions.length);
                return;
              }
              if (event.key === 'ArrowUp' && visible) {
                event.preventDefault();
                setActive((index) => (index <= 0 ? suggestions.length - 1 : index - 1));
                return;
              }
              // Escape schliesst zuerst die Vorschlaege, dann raeumt es das
              // Feld - und erst danach das Slide-over. Das Popover selbst
              // faengt den ersten Fall bereits ab.
              if (event.key === 'Escape' && draft !== '') {
                event.preventDefault();
                event.stopPropagation();
                setDraft('');
                setError(null);
              }
            }}
            className={INPUT_CLASS}
          />

          <Popover open={visible} onClose={() => setOpen(false)} align="start" width="anchor">
            <div id={listId} role="listbox">
              {suggestions.map((tag, index) => (
                <PopoverItem
                  key={tag.id}
                  onClick={() => void add(tag.name)}
                  className={cx(index === active && 'bg-surface-sunken')}
                >
                  {tag.name}
                </PopoverItem>
              ))}
            </div>
          </Popover>
        </div>
      </div>

      <InlineError className="pt-1">{error}</InlineError>
    </DetailSection>
  );
}
