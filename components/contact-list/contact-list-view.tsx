'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { listContactsAction, listFilterOptionsAction } from '@/app/actions';
import { ContactDetailSheet } from '@/components/contact-detail';
import { InlineError } from '@/components/ui';
import type { ContactFilters, ContactListRow, Tag } from '@/lib/types';

import { ContactTable, type SortState } from './contact-table';
import { EMPTY_FILTERS, FilterBar, isFiltered, type FilterState } from './filter-bar';

/**
 * Die Listenansicht: Filterleiste, Tabelle, Slide-over.
 *
 * Hier - und nur hier - entsteht die Abfrage. Filterleiste und Tabelle sind
 * beide zustandslos in Bezug auf die Daten: sie melden Ereignisse nach oben und
 * zeigen, was sie bekommen. Sortiert und gefiltert wird ausschliesslich in der
 * Datenbank (listContactsAction); im Browser wird nichts nachsortiert, sonst
 * waere die Reihenfolge nach der ersten Teilaktualisierung eine andere als die
 * der naechsten vollen Abfrage.
 *
 * Der erste Zustand kommt fertig vom Server (app/page.tsx). Die erste Abfrage
 * im Browser findet deshalb nicht statt - die Seite ist beim ersten Bild schon
 * gefuellt und flackert nicht.
 */

/** Ruhezeit der Live-Suche. Lang genug fuer einen Tastenanschlag, kurz genug, um live zu wirken. */
const SEARCH_DEBOUNCE_MS = 200;

export interface FilterOptions {
  cities: string[];
  tags: Tag[];
}

export interface ContactListViewProps {
  initialRows: ContactListRow[];
  initialOptions: FilterOptions;
  /** Meldung, falls schon das Laden auf dem Server fehlgeschlagen ist. */
  initialError: string | null;
}

export function ContactListView({
  initialRows,
  initialOptions,
  initialError,
}: ContactListViewProps) {
  const [rows, setRows] = useState<ContactListRow[]>(initialRows);
  const [options, setOptions] = useState<FilterOptions>(initialOptions);
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);

  /** Was im Suchfeld steht - aendert sich bei jedem Tastendruck. */
  const [search, setSearch] = useState('');
  /** Was gesucht wird - laeuft dem Suchfeld um die Ruhezeit hinterher. */
  const [query, setQuery] = useState('');

  const [sort, setSort] = useState<SortState | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  /**
   * Unterscheidet "die Datenbank ist leer" von "der Filter ist zu eng" - zwei
   * verschiedene Leerzustaende mit zwei verschiedenen Texten. Der Wert wird nur
   * dann auf false gesetzt, wenn eine Abfrage OHNE jeden Filter leer
   * zurueckkommt; eine leere Trefferliste sagt fuer sich genommen nichts
   * darueber aus, ob es ueberhaupt Kontakte gibt.
   */
  const [hasAnyContacts, setHasAnyContacts] = useState(initialRows.length > 0);

  /**
   * Entprellung des Suchfelds.
   *
   * Erst wenn 200ms lang nichts mehr getippt wurde, wird aus dem Feldinhalt ein
   * Suchbegriff. Der Vergleich am Anfang haelt den Effekt still, sobald beide
   * Werte gleich sind - sonst liefe nach jedem Uebernehmen sofort ein weiterer
   * Zeitgeber an.
   */
  useEffect(() => {
    if (search === query) {
      return;
    }
    const timer = setTimeout(() => setQuery(search), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search, query]);

  /**
   * Die Filter in der Form, die lib/queries.ts erwartet.
   *
   * Nicht gesetzte Facetten fehlen im Objekt, statt als null zu erscheinen -
   * insbesondere status: ohne status-Filter blendet listContacts die
   * archivierten Kontakte aus, und genau das ist der Standard beim Laden.
   * Ein leeres Objekt heisst deshalb zugleich "ungefiltert".
   */
  const request = useMemo<ContactFilters>(() => {
    const next: ContactFilters = {};
    if (filters.status !== null) {
      next.status = filters.status;
    }
    if (filters.stage !== null) {
      next.stage = filters.stage;
    }
    if (filters.role !== null) {
      next.role = filters.role;
    }
    if (filters.city !== null) {
      next.city = filters.city;
    }
    if (filters.tag !== null) {
      next.tag = filters.tag;
    }
    if (filters.hasOpenNeeds) {
      next.hasOpenNeeds = true;
    }
    const trimmed = query.trim();
    if (trimmed !== '') {
      next.query = trimmed;
    }
    return next;
  }, [filters, query]);

  /**
   * Laufende Nummer der Abfragen - die Loesung des Wettlaufs bei der Live-Suche.
   *
   * Das Problem: "Berlin" loest beim schnellen Tippen mehrere Abfragen aus, und
   * die Antworten kommen nicht zwingend in der Reihenfolge zurueck, in der sie
   * gestellt wurden. Trifft die Antwort auf "Berl" nach der auf "Berlin" ein,
   * steht am Ende das Ergebnis zum aelteren Begriff in der Tabelle - sichtbar
   * falsch, und ohne erneute Eingabe nicht mehr zu beheben.
   *
   * Jede Abfrage bekommt deshalb beim Start eine Nummer und schreibt sie in
   * diese Referenz. Beim Eintreffen der Antwort gilt: nur wer noch die aktuelle
   * Nummer traegt, darf schreiben - alle ueberholten Antworten werden
   * verworfen, samt ihres Ladezustands.
   *
   * Kein AbortController: die Anfrage laeuft nicht ueber fetch, sondern als
   * Server Action, und die laesst sich vom Browser aus nicht abbrechen. Sie
   * bricht auch nicht wirklich ab - sie wird nur nicht mehr beachtet. Fuer die
   * Richtigkeit der Anzeige ist das dasselbe.
   */
  const latestRequest = useRef(0);

  /**
   * Der erste Durchlauf laedt nicht nach: initialRows sind bereits das
   * Ergebnis genau dieser Abfrage, serverseitig gerendert.
   */
  const skipFirstLoad = useRef(true);

  useEffect(() => {
    if (skipFirstLoad.current) {
      skipFirstLoad.current = false;
      return;
    }

    const seq = latestRequest.current + 1;
    latestRequest.current = seq;
    setPending(true);

    const unfiltered = Object.keys(request).length === 0;

    void listContactsAction(request, sort ?? undefined).then((result) => {
      if (seq !== latestRequest.current) {
        return;
      }

      setPending(false);
      if (!result.ok) {
        setError(result.error);
        return;
      }

      setError(null);
      setRows(result.data);
      if (result.data.length > 0) {
        setHasAnyContacts(true);
      } else if (unfiltered) {
        setHasAnyContacts(false);
      }
    });
  }, [request, sort]);

  const refreshOptions = useCallback(() => {
    void listFilterOptionsAction().then((result) => {
      if (result.ok) {
        setOptions(result.data);
      }
    });
  }, []);

  const handleReset = useCallback(() => {
    setFilters(EMPTY_FILTERS);
    setSearch('');
    setQuery('');
  }, []);

  const handleOpen = useCallback((id: number) => {
    setSelectedId(id);
  }, []);

  const handleClose = useCallback(() => {
    setSelectedId(null);
  }, []);

  /**
   * Nach jeder Aenderung im Slide-over.
   *
   * Die geaenderte Zeile wird an Ort und Stelle ersetzt, statt die ganze Liste
   * neu zu laden: die Reihenfolge bleibt stehen, der Blick bleibt, wo er war.
   * Dass eine Zeile danach vielleicht nicht mehr zum Filter passt, ist
   * hingenommen - sie verschwindet bei der naechsten Abfrage. Ein Kontakt, der
   * unter den Haenden aus der Liste springt, weil man seine Stadt korrigiert
   * hat, waere die schlechtere Ueberraschung.
   *
   * null heisst geloescht: dann faellt die Zeile heraus und der Slide-over zu.
   * Die Tag-Listen der Filterleiste koennen sich mitgeaendert haben, deshalb
   * werden die Auswahlwerte danach frisch geholt.
   */
  const handleChanged = useCallback(
    (updated: ContactListRow | null) => {
      if (updated === null) {
        setRows((prev) => prev.filter((row) => row.id !== selectedId));
        setSelectedId(null);
        refreshOptions();
        return;
      }
      setRows((prev) => prev.map((row) => (row.id === updated.id ? updated : row)));
      refreshOptions();
    },
    [selectedId, refreshOptions],
  );

  const filtered = isFiltered(filters, search);

  /**
   * Ohne angeklickte Spalte sortiert die Datenbank selbst: nach Relevanz,
   * sobald gesucht wird, sonst alphabetisch. Weil in diesem Fall kein Pfeil in
   * der Kopfzeile steht, sagt es die Leiste in Worten.
   */
  const orderHint = sort !== null ? null : query.trim() === '' ? 'alphabetisch' : 'nach Relevanz';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FilterBar
        search={search}
        onSearchChange={setSearch}
        filters={filters}
        onFiltersChange={setFilters}
        cities={options.cities}
        tags={options.tags}
        onReset={handleReset}
        count={rows.length}
        orderHint={orderHint}
        pending={pending}
      />

      {error === null ? null : (
        <div className="shrink-0 border-b border-border px-6 py-2">
          <InlineError>{error}</InlineError>
        </div>
      )}

      <ContactTable
        rows={rows}
        sort={sort}
        onSortChange={setSort}
        selectedId={selectedId}
        onOpen={handleOpen}
        filtered={filtered}
        hasAnyContacts={hasAnyContacts}
        onResetFilters={handleReset}
        dimmed={pending}
      />

      <ContactDetailSheet contactId={selectedId} onClose={handleClose} onChanged={handleChanged} />
    </div>
  );
}
