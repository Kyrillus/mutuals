'use client';

import { useMemo, useState } from 'react';

import {
  CONTACT_STATUSES,
  ROLES,
  ROLE_LABELS,
  STAGES,
  STAGE_LABELS,
  STATUS_LABELS,
  isContactStatus,
  isRole,
  isStage,
} from '@/lib/constants';
import type { ContactStatus, Role, Stage } from '@/lib/constants';
import type { Tag } from '@/lib/types';
import {
  Button,
  IconCheck,
  IconChevronDown,
  IconClose,
  IconSearch,
  INPUT_CLASS,
  Popover,
  PopoverItem,
  Spinner,
  cx,
} from '@/components/ui';

/**
 * Die Filterleiste ueber der Kontaktliste.
 *
 * Eine einzige 48px-Zeile, buendig mit der Tabelle darunter (px-6): links das
 * Suchfeld, danach die Facetten, rechts die Zeilenzahl. Kein zweiter Streifen,
 * keine Karte, keine ausklappbare Filterschublade - was die Liste gerade
 * einschraenkt, muss ohne Klick lesbar sein.
 *
 * Die Facetten sind Knoepfe mit Popover, nicht native Auswahlfelder: ein
 * gesetzter Filter soll seinen Wert im Knopf zeigen ("Stadt  Berlin") statt in
 * einem Feld zu stecken, das im Ruhezustand wie ein Eingabefeld aussieht.
 * Stadt und Tag bekommen ab neun Eintraegen ein Suchfeld im Menue.
 *
 * Die Leiste haelt keinen eigenen Zustand ausser dem geoeffneten Menue. Werte,
 * Suchtext und Ladeanzeige kommen von aussen (contact-list-view.tsx), damit es
 * genau eine Stelle gibt, an der die Abfrage entsteht.
 */

export interface FilterState {
  status: ContactStatus | null;
  stage: Stage | null;
  role: Role | null;
  city: string | null;
  /** Tag-Name, nicht die ID - so erwartet es ContactFilters. */
  tag: string | null;
  hasOpenNeeds: boolean;
}

/**
 * Der Ausgangszustand: nichts gesetzt.
 *
 * status bleibt bewusst null. listContacts blendet ohne status-Filter genau
 * die archivierten Kontakte aus - das ist der gewuenschte Standard, und er
 * wird hier nicht als expliziter Filter nachgebaut.
 */
export const EMPTY_FILTERS: FilterState = {
  status: null,
  stage: null,
  role: null,
  city: null,
  tag: null,
  hasOpenNeeds: false,
};

/** Schraenkt gerade irgendetwas die Liste ein? Entscheidet ueber den Leerzustand. */
export function isFiltered(filters: FilterState, search: string): boolean {
  return (
    filters.status !== null ||
    filters.stage !== null ||
    filters.role !== null ||
    filters.city !== null ||
    filters.tag !== null ||
    filters.hasOpenNeeds ||
    search.trim() !== ''
  );
}

interface FilterOption {
  value: string;
  label: string;
}

/**
 * Ein Menuewert zurueck in seinen Typ.
 *
 * Das Menue arbeitet mit Strings, der Filter mit Literaltypen. Statt zu casten
 * laufen die Werte durch die Typwaechter aus lib/constants: was dort nicht
 * bekannt ist, hebt den Filter auf, statt als falscher Wert in die Abfrage zu
 * geraten.
 */
function asStatus(value: string | null): ContactStatus | null {
  return isContactStatus(value) ? value : null;
}

function asStage(value: string | null): Stage | null {
  return isStage(value) ? value : null;
}

function asRole(value: string | null): Role | null {
  return isRole(value) ? value : null;
}

/** Ab so vielen Eintraegen bekommt ein Menue ein Suchfeld. */
const SEARCHABLE_FROM = 9;

const STATUS_OPTIONS: readonly FilterOption[] = CONTACT_STATUSES.map((value) => ({
  value,
  label: STATUS_LABELS[value],
}));

const STAGE_OPTIONS: readonly FilterOption[] = STAGES.map((value) => ({
  value,
  label: STAGE_LABELS[value],
}));

const ROLE_OPTIONS: readonly FilterOption[] = ROLES.map((value) => ({
  value,
  label: ROLE_LABELS[value],
}));

interface FilterMenuProps {
  label: string;
  value: string | null;
  options: readonly FilterOption[];
  /** null hebt den Filter auf. */
  onChange: (value: string | null) => void;
  /** Beschriftung der Zeile, die den Filter aufhebt, z.B. "Alle Staedte". */
  allLabel: string;
  /** Text, wenn es ueberhaupt keine Werte gibt. Ein ganzer Satz. */
  emptyText: string;
}

function FilterMenu({ label, value, options, onChange, allLabel, emptyText }: FilterMenuProps) {
  const [open, setOpen] = useState(false);
  const [needle, setNeedle] = useState('');

  const searchable = options.length >= SEARCHABLE_FROM;

  const visible = useMemo(() => {
    const trimmed = needle.trim().toLocaleLowerCase('de-DE');
    if (trimmed === '') {
      return options;
    }
    return options.filter((option) => option.label.toLocaleLowerCase('de-DE').includes(trimmed));
  }, [options, needle]);

  const current = options.find((option) => option.value === value) ?? null;

  function close(): void {
    setOpen(false);
    setNeedle('');
  }

  function pick(next: string | null): void {
    onChange(next);
    close();
  }

  return (
    <div className="relative shrink-0">
      <Button
        variant="outline"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        className={cx('max-w-52', value !== null && 'border-border-strong')}
      >
        <span className={cx('shrink-0', value === null ? 'text-muted' : 'text-faint')}>{label}</span>
        {current === null ? null : (
          <span className="min-w-0 truncate text-fg">{current.label}</span>
        )}
        <IconChevronDown className="shrink-0 text-faint" />
      </Button>

      <Popover open={open} onClose={close} align="start" className="min-w-56">
        {searchable ? (
          <div className="sticky top-0 z-10 mb-1 bg-surface-raised">
            <input
              // Der Fokus darf hier springen: das Menue ist gerade erst durch
              // einen Klick entstanden, und ohne Fokus im Feld muesste man zum
              // Tippen erst noch einmal klicken.
              autoFocus
              value={needle}
              onChange={(event) => setNeedle(event.target.value)}
              placeholder={`${label} suchen`}
              aria-label={`${label} suchen`}
              className={INPUT_CLASS}
            />
          </div>
        ) : null}

        <PopoverItem onClick={() => pick(null)} selected={value === null}>
          {allLabel}
        </PopoverItem>

        {visible.length === 0 ? (
          <p className="px-2 py-2 text-sm text-muted">
            {options.length === 0 ? emptyText : 'Kein Eintrag passt zu dieser Eingabe.'}
          </p>
        ) : (
          visible.map((option) => (
            <PopoverItem
              key={option.value}
              onClick={() => pick(option.value)}
              selected={option.value === value}
            >
              {option.label}
            </PopoverItem>
          ))
        )}
      </Popover>
    </div>
  );
}

export interface FilterBarProps {
  search: string;
  onSearchChange: (value: string) => void;
  filters: FilterState;
  onFiltersChange: (next: FilterState) => void;
  cities: readonly string[];
  tags: readonly Tag[];
  onReset: () => void;
  /** Zeilen in der Tabelle - bleibt waehrend einer Abfrage stehen. */
  count: number;
  /** Kurzes Wort zur Reihenfolge, wenn keine Spalte sortiert ist. */
  orderHint: string | null;
  /** Laeuft gerade eine Abfrage? Nur die Anzeige, nicht die Bedienbarkeit. */
  pending: boolean;
}

export function FilterBar({
  search,
  onSearchChange,
  filters,
  onFiltersChange,
  cities,
  tags,
  onReset,
  count,
  orderHint,
  pending,
}: FilterBarProps) {
  const cityOptions = useMemo<FilterOption[]>(
    () => cities.map((city) => ({ value: city, label: city })),
    [cities],
  );

  const tagOptions = useMemo<FilterOption[]>(
    () => tags.map((tag) => ({ value: tag.name, label: tag.name })),
    [tags],
  );

  const active = isFiltered(filters, search);

  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-6">
      <div className="relative flex shrink-0 items-center">
        <IconSearch className="pointer-events-none absolute left-2 text-faint" />
        <input
          type="text"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Suchen"
          aria-label="Kontakte durchsuchen"
          // Die Suche laeuft live und ohne Formular; ein Enter soll nichts
          // absenden, was es nicht gibt.
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
            }
          }}
          className={cx(INPUT_CLASS, 'w-56 pr-7 pl-7')}
        />
        {search === '' ? null : (
          <button
            type="button"
            onClick={() => onSearchChange('')}
            aria-label="Suche leeren"
            className={cx(
              'absolute right-1 inline-flex size-5 items-center justify-center rounded-xs',
              'text-faint transition-colors duration-75 hover:bg-surface-sunken hover:text-fg',
            )}
          >
            <IconClose width="11" height="11" />
          </button>
        )}
      </div>

      <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border" />

      <FilterMenu
        label="Status"
        value={filters.status}
        options={STATUS_OPTIONS}
        allLabel="Alle ausser archivierten"
        emptyText="Keine Status vorhanden."
        onChange={(value) => onFiltersChange({ ...filters, status: asStatus(value) })}
      />

      <FilterMenu
        label="Phase"
        value={filters.stage}
        options={STAGE_OPTIONS}
        allLabel="Alle Phasen"
        emptyText="Keine Phasen vorhanden."
        onChange={(value) => onFiltersChange({ ...filters, stage: asStage(value) })}
      />

      <FilterMenu
        label="Rolle"
        value={filters.role}
        options={ROLE_OPTIONS}
        allLabel="Alle Rollen"
        emptyText="Keine Rollen vorhanden."
        onChange={(value) => onFiltersChange({ ...filters, role: asRole(value) })}
      />

      <FilterMenu
        label="Stadt"
        value={filters.city}
        options={cityOptions}
        allLabel="Alle Staedte"
        emptyText="Bei keinem Kontakt ist eine Stadt hinterlegt."
        onChange={(value) => onFiltersChange({ ...filters, city: value })}
      />

      <FilterMenu
        label="Tag"
        value={filters.tag}
        options={tagOptions}
        allLabel="Alle Tags"
        emptyText="Noch keine Tags vergeben."
        onChange={(value) => onFiltersChange({ ...filters, tag: value })}
      />

      <Button
        variant="outline"
        aria-pressed={filters.hasOpenNeeds}
        onClick={() => onFiltersChange({ ...filters, hasOpenNeeds: !filters.hasOpenNeeds })}
        className={cx('shrink-0', filters.hasOpenNeeds && 'border-border-strong bg-surface-sunken')}
      >
        {/* Fester Platz fuer den Haken, damit der Knopf beim Umschalten nicht
            seine Breite aendert. */}
        <span className="inline-flex w-3.5 shrink-0 justify-center">
          {filters.hasOpenNeeds ? <IconCheck width="12" height="12" /> : null}
        </span>
        <span className={filters.hasOpenNeeds ? 'text-fg' : 'text-muted'}>Offene Needs</span>
      </Button>

      {active ? (
        <Button variant="ghost" onClick={onReset} className="shrink-0 text-muted hover:text-fg">
          Zuruecksetzen
        </Button>
      ) : null}

      <div className="ml-auto flex shrink-0 items-center gap-2 pl-4">
        {/* Reservierter Platz: der Spinner erscheint und verschwindet, ohne die
            Zeilenzahl daneben zu verschieben. */}
        <span className="inline-flex w-3 justify-center text-faint">
          {pending ? <Spinner label="Kontakte werden geladen" /> : null}
        </span>
        <span className="text-sm text-muted tabular-nums">
          {count === 1 ? '1 Kontakt' : `${count} Kontakte`}
          {orderHint === null ? null : (
            <span className="text-faint"> · {orderHint}</span>
          )}
        </span>
      </div>
    </div>
  );
}
