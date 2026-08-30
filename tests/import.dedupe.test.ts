import { describe, expect, it } from 'vitest';

import {
  buildDedupeIndex,
  type DedupeCandidate,
  type DedupeEntry,
  type DedupeIndex,
} from '@/lib/import/dedupe';

/**
 * Die dreistufige Kaskade. Zwei Fehler sind hier teuer und beide werden unten
 * ausdruecklich abgesichert:
 *   - Ein leerer Wert als Schluessel. Im echten Export hat die Mehrheit der
 *     Zeilen keine E-Mail; wuerde '' matchen, verschmilzt der Import sie alle
 *     zu einem Kontakt.
 *   - Ein Index, der nur den Datenbankstand vor dem Import kennt. Dann sind
 *     zwei gleiche Zeilen in derselben Datei zwei neue Kontakte.
 */

/** Kontakt, wie ihn getAllContactsForDedup liefert - Kurzschreibweise fuer die Tests. */
function entry(
  id: number,
  name: string,
  email: string | null = null,
  linkedinUrl: string | null = null,
): DedupeEntry {
  return { id, name, email, linkedin_url: linkedinUrl };
}

describe('Leere Werte matchen nie', () => {
  it('zwei Kontakte ohne E-Mail sind nicht dieselbe Person', () => {
    const index = buildDedupeIndex([
      entry(1, 'Anna Schmidt'),
      entry(2, 'Paul Brandner'),
      entry(3, 'Lena Vogt'),
    ]);

    // Neue Zeile ohne E-Mail und ohne URL, mit einem Namen, den es noch nicht
    // gibt: das darf nichts treffen, obwohl drei Kontakte "auch keine E-Mail
    // haben".
    expect(index.find({ name: 'Mara Kern', email: '', linkedin_url: '' })).toBeNull();
    expect(index.find({ name: 'Mara Kern' })).toBeNull();
    expect(index.find({ name: 'Mara Kern', email: null, linkedin_url: null })).toBeNull();
  });

  it('ein leerer Name trifft keinen der namenlosen Eintraege', () => {
    const index = buildDedupeIndex([entry(1, '   '), entry(2, '')]);
    expect(index.find({ name: '' })).toBeNull();
    expect(index.find({ name: '   ' })).toBeNull();
    expect(index.find({})).toBeNull();
  });

  it('Platzhalter in der E-Mail-Spalte matchen nicht', () => {
    // '-', 'n/a' und Konsorten stehen in Exporten reihenweise in der
    // E-Mail-Spalte. Als Schluessel waeren sie so schaedlich wie der leere
    // String, nur schwerer zu bemerken.
    const index = buildDedupeIndex([
      entry(1, 'Anna Schmidt', 'n/a'),
      entry(2, 'Paul Brandner', '-'),
    ]);
    expect(index.find({ name: 'Mara Kern', email: 'n/a' })).toBeNull();
    expect(index.find({ name: 'Mara Kern', email: '-' })).toBeNull();
    expect(index.find({ name: 'Mara Kern', email: 'unbekannt' })).toBeNull();
  });

  it('ein leerer Index liefert immer null', () => {
    const index = buildDedupeIndex([]);
    expect(
      index.find({
        name: 'Anna Schmidt',
        email: 'anna@example.com',
        linkedin_url: 'https://www.linkedin.com/in/anna-schmidt',
      }),
    ).toBeNull();
  });
});

describe('Reihenfolge der Kaskade', () => {
  const existing: DedupeEntry[] = [
    entry(1, 'Anna Schmidt', 'anna@example.com', 'https://www.linkedin.com/in/anna-schmidt'),
    entry(2, 'Paul Brandner', 'paul@example.com', 'https://www.linkedin.com/in/paulbrandner'),
    entry(3, 'Lena Vogt', null, null),
  ];

  it('linkedin_url gewinnt gegen E-Mail und Name', () => {
    const index = buildDedupeIndex(existing);
    // Die Zeile passt auf drei verschiedene Kontakte - je Stufe auf einen
    // anderen. Gewinnen muss Stufe 1.
    const match = index.find({
      linkedin_url: 'https://www.linkedin.com/in/anna-schmidt',
      email: 'paul@example.com',
      name: 'Lena Vogt',
    });
    expect(match).toEqual({ id: 1, matchedBy: 'linkedin_url' });
  });

  it('E-Mail gewinnt gegen den Namen', () => {
    const index = buildDedupeIndex(existing);
    const match = index.find({
      linkedin_url: 'https://www.linkedin.com/in/unbekannt',
      email: 'paul@example.com',
      name: 'Lena Vogt',
    });
    expect(match).toEqual({ id: 2, matchedBy: 'email' });
  });

  it('der Name greift zuletzt', () => {
    const index = buildDedupeIndex(existing);
    expect(index.find({ name: 'Lena Vogt' })).toEqual({ id: 3, matchedBy: 'name' });
  });

  it('eine Stufe ohne Treffer blockiert die naechste nicht', () => {
    const index = buildDedupeIndex(existing);
    // URL vorhanden, aber unbekannt: es muss trotzdem auf E-Mail und Name
    // weitergeprueft werden.
    expect(
      index.find({ linkedin_url: 'https://www.linkedin.com/in/niemand', name: 'Lena Vogt' }),
    ).toEqual({ id: 3, matchedBy: 'name' });
  });
});

describe('Normalisierung wirkt im Index', () => {
  const index = buildDedupeIndex([
    entry(1, 'Jürgen Müller', 'Juergen@Example.COM', 'https://www.linkedin.com/in/juergenmueller'),
  ]);

  it('findet den Namen ueber Umlaute, Grossschreibung und Whitespace hinweg', () => {
    expect(index.find({ name: 'JURGEN  MULLER ' })).toEqual({ id: 1, matchedBy: 'name' });
    expect(index.find({ name: 'jürgen müller' })).toEqual({ id: 1, matchedBy: 'name' });
  });

  it('findet die E-Mail unabhaengig von Gross-/Kleinschreibung', () => {
    expect(index.find({ email: 'juergen@example.com' })).toEqual({ id: 1, matchedBy: 'email' });
  });

  it('findet die URL ueber alle Schreibvarianten', () => {
    for (const url of [
      'https://www.linkedin.com/in/juergenmueller',
      'http://linkedin.com/in/juergenmueller/',
      'https://www.linkedin.com/in/juergenmueller?utm_source=share',
      'https://de.linkedin.com/in/juergenmueller',
      'www.linkedin.com/in/JuergenMueller',
    ]) {
      expect(index.find({ linkedin_url: url }), url).toEqual({ id: 1, matchedBy: 'linkedin_url' });
    }
  });
});

describe('Mehrdeutigkeit', () => {
  it('nimmt bei mehreren Kandidaten die kleinste id', () => {
    const index = buildDedupeIndex([
      entry(7, 'Anna Schmidt'),
      entry(3, 'Anna Schmidt'),
      entry(9, 'Anna Schmidt'),
    ]);
    expect(index.find({ name: 'Anna Schmidt' })).toEqual({ id: 3, matchedBy: 'name' });
  });

  it('haengt nicht von der Reihenfolge des Aufbaus ab', () => {
    const rows = [entry(7, 'Anna Schmidt'), entry(3, 'Anna Schmidt'), entry(9, 'Anna Schmidt')];
    const forward = buildDedupeIndex(rows);
    const backward = buildDedupeIndex([...rows].reverse());
    expect(forward.find({ name: 'Anna Schmidt' })).toEqual(backward.find({ name: 'Anna Schmidt' }));
  });

  it('ein spaeter hinzugefuegter Kontakt verdraengt den aelteren nicht', () => {
    const index = buildDedupeIndex([entry(3, 'Anna Schmidt')]);
    index.add(entry(11, 'Anna Schmidt'));
    expect(index.find({ name: 'Anna Schmidt' })).toEqual({ id: 3, matchedBy: 'name' });
  });
});

describe('Der Index waechst waehrend des Imports mit', () => {
  it('erkennt eine Dublette innerhalb derselben Datei', () => {
    // Paul Brandner steht zweimal in der Datei. Ohne add() nach der Neuanlage
    // wuerde die zweite Zeile einen zweiten Kontakt erzeugen.
    const index = buildDedupeIndex([]);
    expect(index.find({ name: 'Paul Brandner' })).toBeNull();

    index.add(entry(1, 'Paul Brandner', null, 'https://www.linkedin.com/in/paulbrandner'));

    expect(index.find({ name: 'Paul Brandner' })).toEqual({ id: 1, matchedBy: 'name' });
    expect(index.find({ linkedin_url: 'http://linkedin.com/in/paulbrandner/' })).toEqual({
      id: 1,
      matchedBy: 'linkedin_url',
    });
  });

  it('nimmt nachgetragene Felder eines ergaenzten Kontakts auf', () => {
    // Der Kontakt lag ohne E-Mail in der Datenbank, eine Importzeile ergaenzt
    // sie. Ab da muss auch die E-Mail-Stufe greifen.
    const index = buildDedupeIndex([entry(1, 'Anna Schmidt')]);
    expect(index.find({ email: 'anna@example.com' })).toBeNull();

    index.add(entry(1, 'Anna Schmidt', 'anna@example.com'));

    expect(index.find({ email: 'anna@example.com' })).toEqual({ id: 1, matchedBy: 'email' });
    expect(index.find({ name: 'Anna Schmidt' })).toEqual({ id: 1, matchedBy: 'name' });
  });

  it('weist unbrauchbare Eintraege beim Aufnehmen zurueck', () => {
    const index = buildDedupeIndex([]);
    expect(() => index.add({ id: 0, name: 'Anna', email: null, linkedin_url: null })).toThrow();
    expect(() => index.add({ id: -1, name: 'Anna', email: null, linkedin_url: null })).toThrow();
    expect(() => index.add({ id: 1.5, name: 'Anna', email: null, linkedin_url: null })).toThrow();
  });
});

describe('Idempotenz eines kompletten Durchlaufs', () => {
  /**
   * Miniatur des Importlaufs aus lib/import/run.ts: pro Zeile nachschlagen,
   * bei Treffer ergaenzen, sonst anlegen - und in beiden Faellen den Stand
   * ueber add() in den Index zuruecktragen.
   */
  function simulateImport(
    index: DedupeIndex,
    rows: readonly DedupeCandidate[],
    firstNewId: number,
  ): { created: number; enriched: number; ids: number[] } {
    let nextId = firstNewId;
    let created = 0;
    let enriched = 0;
    const ids: number[] = [];

    for (const row of rows) {
      const match = index.find(row);
      const id = match?.id ?? nextId++;
      if (match === null) {
        created += 1;
      } else {
        enriched += 1;
      }
      index.add({
        id,
        name: row.name ?? '',
        email: row.email ?? null,
        linkedin_url: row.linkedin_url ?? null,
      });
      ids.push(id);
    }

    return { created, enriched, ids };
  }

  const file: DedupeCandidate[] = [
    { name: 'Paul Brandner', linkedin_url: 'https://www.linkedin.com/in/paulbrandner' },
    { name: 'Anna Schmidt', email: 'anna@example.com' },
    // Dieselbe Person wie Zeile 1, nur andere Schreibweise der URL.
    { name: 'Paul Brandner', linkedin_url: 'http://linkedin.com/in/paulbrandner/' },
    { name: 'Lena Vogt' },
    { name: 'Mara Kern' },
  ];

  it('legt die Dublette innerhalb der Datei nicht doppelt an', () => {
    const index = buildDedupeIndex([]);
    const run = simulateImport(index, file, 1);
    expect(run.created).toBe(4);
    expect(run.enriched).toBe(1);
    // Zeile 1 und Zeile 3 landen auf demselben Kontakt.
    expect(run.ids[0]).toBe(run.ids[2]);
    expect(new Set(run.ids).size).toBe(4);
  });

  it('legt beim zweiten Lauf derselben Datei nichts Neues an', () => {
    const index = buildDedupeIndex([]);
    const first = simulateImport(index, file, 1);
    const second = simulateImport(index, file, 100);

    expect(second.created).toBe(0);
    expect(second.enriched).toBe(file.length);
    expect(second.ids).toEqual(first.ids);
  });

  it('findet beim zweiten Lauf auch Zeilen ohne E-Mail und ohne URL wieder', () => {
    // Die Zeilen 4 und 5 haengen ausschliesslich an der Namensstufe. Genau
    // dort entscheidet sich, ob der Import idempotent ist - im echten Export
    // haben 30 von 40 Zeilen weder E-Mail noch etwas anderes Eindeutiges.
    const index = buildDedupeIndex([]);
    simulateImport(index, file, 1);
    // Vergebene ids: Paul 1, Anna 2, Lena 3, Mara 4 - Zeile 3 ist die Dublette
    // von Zeile 1 und verbraucht keine eigene id.
    expect(index.find({ name: 'Lena Vogt' })).toEqual({ id: 3, matchedBy: 'name' });
    expect(index.find({ name: 'Mara Kern' })).toEqual({ id: 4, matchedBy: 'name' });
  });
});

describe('Ein Gegenbeweis schlaegt den Namenstreffer', () => {
  /**
   * Die Namensstufe ist die schwaechste der Kaskade und die einzige, die zwei
   * verschiedene Menschen treffen kann. Sie darf deshalb nicht greifen, wenn
   * bereits bewiesen ist, dass es zwei sind: beide Seiten tragen denselben
   * Schluesseltyp mit einem belastbaren, aber verschiedenen Wert.
   */
  it('verwirft den Namen, wenn beide Seiten eine andere Profil-URL tragen', () => {
    const index = buildDedupeIndex([
      entry(1, 'Anna Schmidt', null, 'https://www.linkedin.com/in/anna-schmidt-berlin'),
    ]);

    expect(
      index.find({
        name: 'Anna Schmidt',
        linkedin_url: 'https://www.linkedin.com/in/anna-schmidt-muenchen',
      }),
    ).toBeNull();
  });

  it('verwirft den Namen auch bei zwei verschiedenen E-Mail-Adressen', () => {
    const index = buildDedupeIndex([entry(1, 'Anna Schmidt', 'anna.eins@example.com')]);

    expect(index.find({ name: 'Anna Schmidt', email: 'anna.zwei@example.com' })).toBeNull();
  });

  it('laesst den Namen gelten, wenn nur EINE Seite einen Schluessel hat', () => {
    // Eine fehlende URL ist kein Gegenbeweis, sondern eine Luecke. Genau davon
    // lebt der LinkedIn-Export: die Mehrheit der Zeilen hat keine E-Mail.
    const ohneUrl = buildDedupeIndex([entry(1, 'Lena Vogt')]);
    expect(
      ohneUrl.find({ name: 'Lena Vogt', linkedin_url: 'https://www.linkedin.com/in/lena-vogt' }),
    ).toEqual({ id: 1, matchedBy: 'name' });

    const mitUrl = buildDedupeIndex([
      entry(2, 'Lena Vogt', null, 'https://www.linkedin.com/in/lena-vogt'),
    ]);
    expect(mitUrl.find({ name: 'Lena Vogt' })).toEqual({ id: 2, matchedBy: 'name' });
  });

  it('nimmt denselben Schluessel auf beiden Seiten nicht als Widerspruch', () => {
    // Dieselbe URL trifft ohnehin schon auf Stufe 1 - hier zaehlt nur, dass
    // die Namensstufe sie nicht faelschlich als Gegenbeweis liest.
    const index = buildDedupeIndex([
      entry(1, 'Paul Brandner', null, 'https://www.linkedin.com/in/paulbrandner'),
    ]);
    expect(
      index.find({ name: 'Paul Brandner', linkedin_url: 'http://linkedin.com/in/paulbrandner/' }),
    ).toEqual({ id: 1, matchedBy: 'linkedin_url' });
  });

  it('geht zum naechsten Namensvetter weiter, statt gleich aufzugeben', () => {
    // Der Gegenbeweis gilt je Kontakt, nicht je Name: dass Kontakt 1
    // widerspricht, sagt ueber Kontakt 2 nichts aus.
    const index = buildDedupeIndex([
      entry(1, 'Anna Schmidt', null, 'https://www.linkedin.com/in/anna-schmidt-berlin'),
      entry(2, 'Anna Schmidt'),
    ]);

    expect(
      index.find({
        name: 'Anna Schmidt',
        linkedin_url: 'https://www.linkedin.com/in/anna-schmidt-muenchen',
      }),
    ).toEqual({ id: 2, matchedBy: 'name' });
  });

  it('verliert einen einmal bekannten Schluessel beim erneuten add nicht', () => {
    // Ein ergaenzter Kontakt wird ein zweites Mal aufgenommen. Kaeme er dabei
    // ohne seine URL, waere der Gegenbeweis danach weg.
    const index = buildDedupeIndex([
      entry(1, 'Anna Schmidt', null, 'https://www.linkedin.com/in/anna-schmidt-berlin'),
    ]);
    index.add(entry(1, 'Anna Schmidt', 'anna@example.com', null));

    expect(
      index.find({
        name: 'Anna Schmidt',
        linkedin_url: 'https://www.linkedin.com/in/anna-schmidt-muenchen',
      }),
    ).toBeNull();
  });
});
