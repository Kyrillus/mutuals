/**
 * Die zustandslosen Teile der Detailansicht.
 *
 * Alles hier ist eine reine Funktion ueber den Daten, die der Server geliefert
 * hat: umsortieren, ersetzen, in die Form bringen, die die aufrufende Ansicht
 * erwartet. Kein React, kein Zugriff auf Server Actions - damit bleibt der
 * Rest der Detailansicht auf Bedienlogik beschraenkt.
 *
 * Die Sortierungen bilden bewusst genau die ORDER-BY-Klauseln aus
 * lib/queries.ts nach. Sie werden gebraucht, weil optimistisch geaenderte und
 * neu angelegte Eintraege im Browser einsortiert werden, ohne die Liste neu zu
 * holen; wuerde hier anders sortiert, spraenge die Reihenfolge bei der
 * naechsten vollen Abfrage sichtbar um.
 */

import type { ContactDetail, ContactItem, ContactListRow, Note, Tag } from '@/lib/types';

/** Needs und Offers sind dasselbe Ding in zwei Tabellen - unterschieden wird hier. */
export type ItemKind = 'need' | 'offer';

/** SQLite sortiert Tags mit COLLATE NOCASE, dieser Vergleich zusaetzlich Umlaute. */
const COLLATOR = new Intl.Collator('de', { sensitivity: 'base' });

/**
 * Die Zeile, die Liste und Board von onChanged erwarten.
 *
 * open_needs_count und tags haengen nicht am Kontakt, sondern an dem, was
 * gerade in dieser Ansicht steht - sie werden deshalb aus dem geladenen Detail
 * gerechnet und nicht vom Server nachgefragt.
 */
export function toListRow(detail: ContactDetail): ContactListRow {
  // offers und notes werden mitgenannt, damit sie im Rest NICHT enthalten sind
  // und so gar nicht erst in der Zeile landen koennen: Notizen sind die
  // private Schicht und haben in einer Listenzeile nichts verloren.
  const { needs, offers, tags, notes, ...contact } = detail;

  return {
    ...contact,
    open_needs_count: needs.filter((need) => need.resolved_at === null).length,
    tags: tags.map((tag) => tag.name),
  };
}

/** Offene zuerst, darin die aeltesten - wie ITEM_ORDER in lib/queries.ts. */
export function sortItems(items: readonly ContactItem[]): ContactItem[] {
  return items.slice().sort((a, b) => {
    const byResolved = Number(a.resolved_at !== null) - Number(b.resolved_at !== null);
    if (byResolved !== 0) {
      return byResolved;
    }
    if (a.created_at !== b.created_at) {
      return a.created_at < b.created_at ? -1 : 1;
    }
    return a.id - b.id;
  });
}

/** Neueste zuerst, Notizen ohne Datum ganz unten - wie listNotes in lib/queries.ts. */
export function sortNotes(notes: readonly Note[]): Note[] {
  return notes.slice().sort((a, b) => {
    const byMissing = Number(a.occurred_on === null) - Number(b.occurred_on === null);
    if (byMissing !== 0) {
      return byMissing;
    }
    const dayA = a.occurred_on ?? '';
    const dayB = b.occurred_on ?? '';
    if (dayA !== dayB) {
      return dayA < dayB ? 1 : -1;
    }
    if (a.created_at !== b.created_at) {
      return a.created_at < b.created_at ? 1 : -1;
    }
    return b.id - a.id;
  });
}

export function sortTags(tags: readonly Tag[]): Tag[] {
  return tags.slice().sort((a, b) => COLLATOR.compare(a.name, b.name));
}

export function itemsOf(detail: ContactDetail, kind: ItemKind): readonly ContactItem[] {
  return kind === 'need' ? detail.needs : detail.offers;
}

/** Ersetzt Needs oder Offers und laesst den Rest des Details unberuehrt. */
export function withItems(
  detail: ContactDetail,
  kind: ItemKind,
  items: readonly ContactItem[],
): ContactDetail {
  const sorted = sortItems(items);
  return kind === 'need' ? { ...detail, needs: sorted } : { ...detail, offers: sorted };
}

/** Denselben Eintrag durch eine neue Fassung ersetzen; unbekannte bleiben weg. */
export function replaceItem(
  items: readonly ContactItem[],
  next: ContactItem,
): readonly ContactItem[] {
  return items.map((item) => (item.id === next.id ? next : item));
}

export function countOpen(items: readonly ContactItem[]): number {
  return items.filter((item) => item.resolved_at === null).length;
}

/**
 * Die gedaempfte Zeile unter dem Namen: Rolle, Firma, Stadt.
 *
 * Leere Angaben fallen heraus, statt als Gedankenstrich zu erscheinen - im
 * Kopf steht, was bekannt ist, und sonst nichts. Sind alle drei leer, gibt es
 * die Zeile gar nicht.
 */
export function joinSubtitle(parts: ReadonlyArray<string | null>): string | null {
  const kept = parts.filter((part): part is string => part !== null && part.trim() !== '');
  return kept.length === 0 ? null : kept.join(' · ');
}
