'use client';

import { useEffect, useRef, useState } from 'react';

import { listContactsAction } from '@/app/actions';
import type { ContactListRow } from '@/lib/types';

/**
 * Die Volltextsuche der Palette.
 *
 * Dieselbe Mechanik wie in der Listenansicht, und zwar bewusst dieselbe:
 * entprellte Eingabe, laufende Nummer gegen ueberholte Antworten, keine
 * Nachsortierung im Browser. Wer beides nebeneinander liest, soll denselben
 * Ablauf erkennen.
 *
 * Die Ruhezeit ist mit 160ms etwas kuerzer als in der Liste (200ms): die
 * Palette liefert acht Zeilen statt einer ganzen Tabelle, und sie wird
 * benutzt, um in einem Zug zu einem Namen zu springen.
 */
const DEBOUNCE_MS = 160;

/** Mehr Zeilen liest im Sprung ohnehin niemand - der Rest steht in der Liste. */
export const MAX_RESULTS = 8;

export interface ContactSearch {
  /** Hoechstens MAX_RESULTS Zeilen, in der Reihenfolge der Datenbank. */
  rows: ContactListRow[];
  /** Wie viele es insgesamt waren - fuer den Hinweis unter den Treffern. */
  total: number;
  /** Laeuft eine Abfrage, oder wartet die Eingabe noch auf ihre Ruhezeit? */
  pending: boolean;
  error: string | null;
}

const IDLE: ContactSearch = { rows: [], total: 0, pending: false, error: null };

/**
 * input ist der rohe Feldinhalt; die Entprellung passiert hier drin, damit
 * die Ansicht nur einen Wert zu fuehren hat.
 *
 * Archivierte Kontakte fehlen in den Treffern: listContacts blendet sie ohne
 * status-Filter aus. Das ist dieselbe Voreinstellung wie in der Liste, und
 * ein Archiv soll beim Suchen nicht dazwischenfunken.
 */
export function useContactSearch(input: string): ContactSearch {
  const trimmed = input.trim();

  /** Was gesucht wird - laeuft dem Feld um die Ruhezeit hinterher. */
  const [query, setQuery] = useState('');
  const [state, setState] = useState<ContactSearch>(IDLE);

  useEffect(() => {
    if (trimmed === query) {
      return;
    }
    const timer = setTimeout(() => setQuery(trimmed), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [trimmed, query]);

  /**
   * Laufende Nummer der Abfragen. Kommt die Antwort auf "Berl" nach der auf
   * "Berlin" zurueck, wird sie verworfen - sonst stuende am Ende das
   * Ergebnis des aelteren Begriffs in der Liste. Abbrechen laesst sich eine
   * Server Action nicht; nicht mehr beachtet werden schon.
   */
  const latest = useRef(0);

  useEffect(() => {
    if (query === '') {
      // Auch das ist ein Wechsel des Suchbegriffs: eine noch laufende
      // Antwort darf die geleerte Trefferliste nicht wieder fuellen.
      latest.current += 1;
      setState(IDLE);
      return;
    }

    const seq = latest.current + 1;
    latest.current = seq;
    setState((prev) => ({ ...prev, pending: true }));

    void listContactsAction({ query }).then((result) => {
      if (seq !== latest.current) {
        return;
      }
      if (!result.ok) {
        setState({ rows: [], total: 0, pending: false, error: result.error });
        return;
      }
      setState({
        rows: result.data.slice(0, MAX_RESULTS),
        total: result.data.length,
        pending: false,
        error: null,
      });
    });
  }, [query]);

  // Der Ladezustand beginnt schon waehrend der Ruhezeit. Sonst blitzt der
  // Hinweis auf null Treffer auf, bevor ueberhaupt gesucht wurde.
  return { ...state, pending: state.pending || trimmed !== query };
}
