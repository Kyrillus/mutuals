'use client';

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { Dialog, IconSearch, InlineError, Kbd, Spinner, cx } from '@/components/ui';
import type { ContactListRow } from '@/lib/types';

import { useContactSearch } from './use-contact-search';

/**
 * Die Palette selbst: Eingabefeld, gruppierte Treffer, Tastaturbedienung.
 *
 * Diese Datei zeigt und waehlt aus, sie handelt nicht. Was beim Auswaehlen
 * passiert - navigieren, Kontakt oeffnen, Dialog aufmachen - liegt in
 * components/command-palette.tsx. Der Grund ist die Lebensdauer: die Palette
 * ist waehrend ihrer Wirkung meistens schon geschlossen.
 *
 * Die Auswahl liegt auf einer FLACHEN Liste aus Kontakten und Aktionen; die
 * Gruppen sind nur die Darstellung davon. Zwei Indizes nebeneinander zu
 * fuehren waere die Sorte Zustand, die beim naechsten Sonderfall auseinander
 * laeuft.
 */

export interface PaletteAction {
  id: string;
  label: string;
  /** Weitere Woerter, unter denen die Aktion gefunden werden soll. */
  keywords: string;
  run: () => void;
}

export interface PaletteProps {
  open: boolean;
  onClose: () => void;
  actions: PaletteAction[];
  onSelectContact: (id: number) => void;
}

type Row =
  | { kind: 'contact'; contact: ContactListRow }
  | { kind: 'action'; action: PaletteAction };

/** Firma und Stadt in einer Zeile; fehlt beides, entfaellt die Zeile. */
function metaOf(contact: ContactListRow): string | null {
  const parts = [contact.company, contact.city].filter(
    (value): value is string => value !== null && value.trim() !== '',
  );
  return parts.length === 0 ? null : parts.join(' · ');
}

/** Aktionen werden mitgefiltert - sonst steht "Zum Import" unter der Suche nach "Anna". */
function actionMatches(action: PaletteAction, needle: string): boolean {
  if (needle === '') {
    return true;
  }
  return `${action.label} ${action.keywords}`.toLowerCase().includes(needle);
}

export function Palette({ open, onClose, actions, onSelectContact }: PaletteProps) {
  const [input, setInput] = useState('');
  const [active, setActive] = useState(0);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const baseId = useId();

  // Die Suche ruht, solange die Palette zu ist: die Server Action soll nicht
  // laufen, weil irgendwo noch der Text der letzten Sitzung steht.
  const search = useContactSearch(open ? input : '');

  const needle = input.trim().toLowerCase();

  /**
   * Beim Oeffnen ist die Palette leer und der Fokus im Feld.
   *
   * Der Fokus wird hier gesetzt und nicht ueber autoFocus: der Dialog gibt
   * beim Oeffnen zuerst dem Panel den Fokus (use-native-dialog.ts). Dieser
   * Effekt liegt in der Elternkomponente des Dialogs und laeuft deshalb
   * danach - das Feld gewinnt.
   */
  useEffect(() => {
    if (!open) {
      return;
    }
    setInput('');
    setActive(0);
    inputRef.current?.focus();
  }, [open]);

  const contacts = needle === '' ? [] : search.rows;
  const visibleActions = useMemo(
    () => actions.filter((action) => actionMatches(action, needle)),
    [actions, needle],
  );

  const rows = useMemo<Row[]>(() => {
    const list: Row[] = contacts.map((contact) => ({ kind: 'contact', contact }));
    for (const action of visibleActions) {
      list.push({ kind: 'action', action });
    }
    return list;
  }, [contacts, visibleActions]);

  // Die Trefferliste aendert sich unter der Auswahl - der Index wird deshalb
  // erst beim Lesen begrenzt und nicht bei jeder Antwort zurueckgesetzt.
  const activeIndex = rows.length === 0 ? -1 : Math.min(active, rows.length - 1);

  useEffect(() => {
    setActive(0);
  }, [needle]);

  /** Die gewaehlte Zeile mitfuehren, ohne den Rest der Liste zu bewegen. */
  useEffect(() => {
    if (activeIndex < 0) {
      return;
    }
    const element = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    element?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, rows.length]);

  function run(index: number): void {
    const row = rows[index];
    if (row === undefined) {
      return;
    }
    // Erst schliessen, dann handeln: oeffnet die Aktion ihrerseits einen
    // Dialog, laufen beide Wirkungen im selben Durchlauf und der Fokus
    // wandert genau einmal.
    onClose();
    if (row.kind === 'contact') {
      onSelectContact(row.contact.id);
      return;
    }
    row.action.run();
  }

  function move(delta: number): void {
    if (rows.length === 0) {
      return;
    }
    // Umlaufend: unten weiter fuehrt nach oben. Am Ende der Liste haengen zu
    // bleiben ist bei acht Zeilen kein Schutz, sondern eine Sackgasse.
    setActive((prev) => {
      const from = Math.min(prev, rows.length - 1);
      return (from + delta + rows.length) % rows.length;
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      run(activeIndex);
    }
    // Escape faengt der Dialog: das Ereignis blubbert von hier nach oben,
    // und dort liegt die einzige Stelle, die Fokusrueckgabe und Zustand in
    // der richtigen Reihenfolge erledigt.
  }

  const showEmpty = rows.length === 0 && !search.pending && search.error === null;
  const rest = search.total - contacts.length;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      ariaLabel="Suche"
      width="md"
      flush
      footer={<Hints pending={search.pending} />}
    >
      <div className="flex flex-col">
        {/* Kein <Input>: das Primitiv ist ein 28px hohes, gerahmtes
            Bedienelement. Der Kopf der Palette ist kein Feld in einem
            Formular, sondern die Zeile, in der man steht - Rahmen und
            Fokusring waeren hier ein Kasten im Kasten. Sichtbar ist der
            Fokus trotzdem: die Palette ist offen, und sie hat nur diese
            eine Eingabe. */}
        <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-border px-3.5">
          <IconSearch className="shrink-0 text-faint" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={rows.length > 0}
            aria-controls={`${baseId}-list`}
            aria-activedescendant={activeIndex < 0 ? undefined : `${baseId}-option-${activeIndex}`}
            aria-autocomplete="list"
            aria-label="Kontakte und Aktionen durchsuchen"
            autoComplete="off"
            spellCheck={false}
            placeholder="Kontakt suchen oder Aktion waehlen"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            className={cx(
              'h-full min-w-0 flex-1 bg-transparent text-md text-fg',
              'placeholder:text-faint focus-visible:outline-none',
            )}
          />
        </div>

        <div
          ref={listRef}
          id={`${baseId}-list`}
          role="listbox"
          aria-label="Treffer"
          className="max-h-80 min-h-0 overflow-y-auto py-1.5"
        >
          {contacts.length === 0 ? null : (
            <div role="group" aria-label="Kontakte">
              <GroupLabel>Kontakte</GroupLabel>
              {contacts.map((contact, index) => {
                const meta = metaOf(contact);
                return (
                  <Option
                    key={`contact-${contact.id}`}
                    id={`${baseId}-option-${index}`}
                    index={index}
                    active={index === activeIndex}
                    onSelect={run}
                    onHover={setActive}
                  >
                    <span className="block truncate text-base text-fg">{contact.name}</span>
                    {meta === null ? null : (
                      <span className="block truncate text-sm text-muted">{meta}</span>
                    )}
                  </Option>
                );
              })}
              {rest <= 0 ? null : (
                <p className="px-3.5 pt-1 pb-0.5 text-sm text-faint">
                  {rest === 1 ? 'Ein weiterer Treffer' : `${rest} weitere Treffer`} - die Liste
                  zeigt alle.
                </p>
              )}
            </div>
          )}

          {visibleActions.length === 0 ? null : (
            <div role="group" aria-label="Aktionen">
              <GroupLabel>Aktionen</GroupLabel>
              {visibleActions.map((action, offset) => {
                const index = contacts.length + offset;
                return (
                  <Option
                    key={`action-${action.id}`}
                    id={`${baseId}-option-${index}`}
                    index={index}
                    active={index === activeIndex}
                    onSelect={run}
                    onHover={setActive}
                  >
                    <span className="block truncate text-base text-fg">{action.label}</span>
                  </Option>
                );
              })}
            </div>
          )}

          {search.error === null ? null : (
            <div className="px-3.5 py-2">
              <InlineError>{search.error}</InlineError>
            </div>
          )}

          {showEmpty ? (
            <p className="mx-auto max-w-80 px-3.5 py-6 text-center text-sm text-muted">
              Kein Kontakt und keine Aktion passt dazu. Andere Schreibweise versuchen oder das
              Feld leeren.
            </p>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}

function GroupLabel({ children }: { children: string }) {
  // aria-hidden, weil die Gruppe daneben schon aria-label traegt - sonst
  // liest ein Bildschirmleser die Ueberschrift zweimal vor.
  return (
    <p aria-hidden="true" className="px-3.5 pt-1.5 pb-1 text-xs font-medium text-faint">
      {children}
    </p>
  );
}

interface OptionProps {
  id: string;
  index: number;
  active: boolean;
  onSelect: (index: number) => void;
  onHover: (index: number) => void;
  children: ReactNode;
}

/**
 * Eine Zeile. Kein <button>: in einer Listbox gehoert die Rolle option an das
 * Element, und der Fokus bleibt waehrenddessen im Eingabefeld - deshalb auch
 * das preventDefault beim Druecken der Maustaste.
 */
function Option({ id, index, active, onSelect, onHover, children }: OptionProps) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      data-index={index}
      onMouseMove={() => onHover(index)}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onSelect(index)}
      className={cx(
        'cursor-default px-3.5 py-1.5',
        active ? 'bg-accent-soft' : 'bg-transparent',
      )}
    >
      <span className="block min-w-0">{children}</span>
    </div>
  );
}

/** Die Tastenhinweise im Fuss - die Palette erklaert sich selbst. */
function Hints({ pending }: { pending: boolean }) {
  return (
    <div className="flex w-full items-center gap-4 text-sm text-muted">
      <span className="flex items-center gap-1.5">
        <span className="flex gap-0.5">
          <Kbd>&uarr;</Kbd>
          <Kbd>&darr;</Kbd>
        </span>
        bewegen
      </span>
      <span className="flex items-center gap-1.5">
        <Kbd>Enter</Kbd>
        waehlen
      </span>
      <span className="flex items-center gap-1.5">
        <Kbd>Esc</Kbd>
        schliessen
      </span>
      {pending ? <Spinner className="ml-auto text-faint" label="Suche laeuft" /> : null}
    </div>
  );
}
