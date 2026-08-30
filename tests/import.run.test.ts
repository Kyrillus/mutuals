import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { withTransaction } from '@/lib/db';
import type {
  DedupeCandidate,
  DedupeEntry,
  DedupeIndex,
  DedupeMatch,
} from '@/lib/import/dedupe';
import { parseFile } from '@/lib/import/parse';
import { importParsedFile } from '@/lib/import/run';
import type { ColumnMapping, ImportSummary, ParsedFile, RawRow } from '@/lib/import/types';
import {
  createContact,
  deleteContact,
  findContactByLinkedinUrl,
  getAllContactsForDedup,
  getContact,
  listContacts,
} from '@/lib/queries';

/**
 * Schalter fuer den simulierten harten Abbruch (siehe den letzten Block).
 *
 * Ein Fehler EINER Zeile ist per Konstruktion kein harter Abbruch - run.ts
 * faengt ihn ab und protokolliert ihn, damit eine kaputte Zeile nicht die
 * uebrigen 899 verhindert. Ein Abbruch mitten im Lauf (Datenbank gesperrt,
 * Platte voll, Prozess in Not) muss deshalb an einer Stelle innerhalb der
 * Schleife eingespeist werden, die NICHT zeilenlokal abgesichert ist: der
 * Dublettenpruefung. Solange atFindCall auf 0 steht, ist der Wrapper eine
 * reine Durchreiche und alle uebrigen Tests laufen gegen die echte Logik.
 */
const crash = vi.hoisted(() => ({ atFindCall: 0 }));

vi.mock('@/lib/import/dedupe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/import/dedupe')>();

  return {
    ...actual,
    buildDedupeIndex(existing: readonly DedupeEntry[]): DedupeIndex {
      const index = actual.buildDedupeIndex(existing);
      let calls = 0;

      return {
        add(entry: DedupeEntry): void {
          index.add(entry);
        },
        find(candidate: DedupeCandidate): DedupeMatch | null {
          calls += 1;
          if (crash.atFindCall === calls) {
            throw new Error('Datenbankverbindung verloren (simulierter Abbruch)');
          }
          return index.find(candidate);
        },
      };
    },
  };
});

/**
 * Der Import als Ganzes, gegen die Wegwerf-Datenbank aus vitest.config.ts.
 *
 * Die beiden Eigenschaften, an denen dieser Schritt haengt:
 *   - Idempotenz. Dieselbe Datei zweimal eingelesen darf keinen einzigen
 *     Kontakt doppelt anlegen - auch dann nicht, wenn die Datei selbst
 *     Dubletten enthaelt.
 *   - Ergaenzen statt ueberschreiben. Ein gepflegtes Feld darf ein spaeterer
 *     Import nie ueberschreiben; ein leeres darf er fuellen.
 */

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'linkedin-connections.csv',
);

/** Leert die Kontakte (Cascade raeumt alles daran Haengende mit). */
function resetContacts(): void {
  withTransaction(() => {
    for (const contact of getAllContactsForDedup()) {
      deleteContact(contact.id);
    }
  });
}

/** Baut ein ParsedFile von Hand - fuer Faelle, die keine Datei brauchen. */
function parsedFile(headers: string[], rows: RawRow[]): ParsedFile {
  return { headers, rows, preambleLines: 0, format: 'csv' };
}

/** Kurzform der Bilanz fuer die Erwartungen unten. */
function counts(summary: ImportSummary): [number, number, number, number] {
  return [summary.created, summary.enriched, summary.skipped, summary.errors];
}

/** Alle Kontakte mit diesem Namen - fuer die Frage "gibt es die Person zweimal?". */
function contactsNamed(name: string): { id: number; name: string }[] {
  return getAllContactsForDedup().filter((contact) => contact.name === name);
}

beforeEach(() => {
  crash.atFindCall = 0;
  resetContacts();
});

describe('Der echte LinkedIn-Export', () => {
  it('legt aus 40 Zeilen 37 Personen an und laesst die drei Dubletten liegen', () => {
    const parsed = parseFile(FIXTURE);
    expect(parsed.rows).toHaveLength(40);

    const summary = importParsedFile(parsed, { source: 'linkedin' });

    expect(summary.total).toBe(40);
    expect(summary.created).toBe(37);
    expect(summary.errors).toBe(0);
    // Drei Zeilen sind Dubletten: eine ueber die URL, eine ueber die E-Mail,
    // eine ueber den normalisierten Namen. Nur die erste bringt einen neuen
    // Wert mit (die E-Mail-Adresse), die beiden anderen wiederholen, was schon
    // dasteht.
    expect(summary.enriched).toBe(1);
    expect(summary.skipped).toBe(2);
    expect(getAllContactsForDedup()).toHaveLength(37);

    const matched = summary.rows.filter((row) => row.matchedBy !== undefined);
    expect(matched.map((row) => row.matchedBy)).toEqual(['linkedin_url', 'email', 'name']);
  });

  it('legt beim zweiten Lauf derselben Datei keinen einzigen Kontakt an', () => {
    const parsed = parseFile(FIXTURE);
    importParsedFile(parsed, { source: 'linkedin' });

    const second = importParsedFile(parsed, { source: 'linkedin' });

    expect(counts(second)).toEqual([0, 0, 40, 0]);
    expect(second.rows.every((row) => row.reason === 'nichts zu ergänzen')).toBe(true);
    expect(getAllContactsForDedup()).toHaveLength(37);
  });

  it('ergaenzt aus der Dublette nur das leere Feld und ruehrt das gefuellte nicht an', () => {
    // Zeile 5 der Datei: Paul Brandner, "Partner", ohne E-Mail.
    // Zeile 32: derselbe Mensch mit E-Mail und "General Partner".
    const summary = importParsedFile(parseFile(FIXTURE), { source: 'linkedin' });
    const enriched = summary.rows.find((row) => row.outcome === 'enriched');
    const contact = getContact(enriched?.contactId ?? 0);

    expect(contact?.name).toBe('Paul Brandner');
    expect(contact?.email).toBe('paul.brandner@example.com');
    expect(contact?.title).toBe('Partner');
  });

  it('gibt jedem einzelnen der 37 Kontakte Status "imported" und Quelle "linkedin"', () => {
    importParsedFile(parseFile(FIXTURE), { source: 'linkedin' });

    // Nicht nur der erste: ein Import, der bei Zeile 20 auf 'active' umspringt,
    // waere von einer Stichprobe nicht zu unterscheiden.
    const imported = listContacts({ status: 'imported' });
    expect(imported).toHaveLength(37);
    expect(imported.every((contact) => contact.source === 'linkedin')).toBe(true);
    expect(getAllContactsForDedup()).toHaveLength(37);
  });

  it('uebernimmt "Connected On" als Anlagedatum', () => {
    importParsedFile(parseFile(FIXTURE), { source: 'linkedin' });

    const dates = listContacts({ status: 'imported' }).map((contact) => contact.created_at);
    expect(dates).toContain('2023-03-14');
    expect(dates).toContain('2025-08-08');
    // Alle 37 tragen ein Datum aus der Datei, keines den Zeitpunkt des Imports.
    expect(dates.every((date) => /^\d{4}-\d{2}-\d{2}$/u.test(date))).toBe(true);
    expect(new Set(dates).size).toBe(37);
  });
});

describe('Die drei Dubletten der Datei, einzeln', () => {
  /** Das Ergebnis genau einer Datenzeile (1-basiert, ohne Kopfzeile). */
  function rowResult(summary: ImportSummary, rowNumber: number) {
    const result = summary.rows.find((row) => row.rowNumber === rowNumber);
    if (result === undefined) {
      throw new Error(`Keine Bilanzzeile ${rowNumber}`);
    }
    return result;
  }

  it('Stufe 1, Profil-URL: Paul Brandner bekommt die E-Mail, behaelt aber den Titel', () => {
    // Zeile 28 ist derselbe Mensch wie Zeile 1: gleiche URL, diesmal mit
    // E-Mail-Adresse und mit "General Partner" statt "Partner".
    const summary = importParsedFile(parseFile(FIXTURE), { source: 'linkedin' });
    const result = rowResult(summary, 28);

    expect(result.outcome).toBe('enriched');
    expect(result.matchedBy).toBe('linkedin_url');

    expect(contactsNamed('Paul Brandner')).toHaveLength(1);
    const paul = getContact(result.contactId ?? 0);
    expect(paul?.email).toBe('paul.brandner@example.com');
    // Das leere Feld wurde gefuellt, das gefuellte nicht angefasst.
    expect(paul?.title).toBe('Partner');
    expect(paul?.company).toBe('Alpine Health Ventures');
  });

  it('Stufe 2, E-Mail: JÜRGEN MÜLLER trifft Jürgen Müller ohne URL', () => {
    // Zeile 29 hat keine Profil-URL - Stufe 1 laeuft ins Leere, Stufe 2 greift.
    const summary = importParsedFile(parseFile(FIXTURE), { source: 'linkedin' });
    const result = rowResult(summary, 29);

    expect(result.matchedBy).toBe('email');
    expect(result.outcome).toBe('skipped');
    expect(result.reason).toBe('nichts zu ergänzen');

    expect(contactsNamed('Jürgen Müller')).toHaveLength(1);
    expect(contactsNamed('JÜRGEN MÜLLER')).toHaveLength(0);
    const juergen = getContact(result.contactId ?? 0);
    // Der kuerzere Titel der Dublette darf den laengeren nicht verdraengen.
    expect(juergen?.title).toBe('Head of Engineering, Diagnostics');
    expect(juergen?.linkedin_url).toBe('https://www.linkedin.com/in/juergen-mueller-42');
  });

  it('Stufe 3, Name: "  Lena  Schmidt  " trifft Lena Schmidt ohne URL und ohne E-Mail', () => {
    // Zeile 30 hat weder URL noch E-Mail. Bliebe der Whitespace stehen oder
    // fiele die Namensstufe aus, entstuende hier ein zweiter Kontakt.
    const summary = importParsedFile(parseFile(FIXTURE), { source: 'linkedin' });
    const result = rowResult(summary, 30);

    expect(result.matchedBy).toBe('name');
    expect(result.outcome).toBe('skipped');

    expect(contactsNamed('Lena Schmidt')).toHaveLength(1);
    const lena = getContact(result.contactId ?? 0);
    expect(lena?.linkedin_url).toBe('https://www.linkedin.com/in/lena-schmidt-ai');
  });

  it('probiert die Stufen in der vorgegebenen Reihenfolge und nur dort, wo sie greifen', () => {
    const summary = importParsedFile(parseFile(FIXTURE), { source: 'linkedin' });
    const matched = summary.rows.filter((row) => row.matchedBy !== undefined);

    expect(matched.map((row) => [row.rowNumber, row.matchedBy])).toEqual([
      [28, 'linkedin_url'],
      [29, 'email'],
      [30, 'name'],
    ]);
    // Die 37 uebrigen Zeilen haben keine Dublette getroffen - insbesondere hat
    // die leere E-Mail-Spalte der meisten Zeilen keine Treffer erzeugt.
    expect(summary.rows.filter((row) => row.outcome === 'created')).toHaveLength(37);
  });
});

describe('Trockenlauf', () => {
  it('rechnet dasselbe aus wie der Echtlauf und schreibt nichts', () => {
    const parsed = parseFile(FIXTURE);

    const dry = importParsedFile(parsed, { source: 'linkedin', dryRun: true });
    expect(getAllContactsForDedup()).toHaveLength(0);

    const real = importParsedFile(parsed, { source: 'linkedin' });
    expect(counts(dry)).toEqual(counts(real));
  });

  it('laesst auch eine gefuellte Datenbank unveraendert', () => {
    const bestand = createContact({ name: 'Bestandsperson Ohne Bezug', status: 'active' });
    const vorher = getAllContactsForDedup();

    const dry = importParsedFile(parseFile(FIXTURE), { source: 'linkedin', dryRun: true });

    // Die Bilanz meldet, was ein Echtlauf taete ...
    expect(counts(dry)).toEqual([37, 1, 2, 0]);
    // ... geschrieben ist trotzdem nichts, auch nicht am bestehenden Kontakt.
    expect(getAllContactsForDedup()).toEqual(vorher);
    expect(getContact(bestand.id)).toEqual(bestand);
  });
});

describe('Zeilen ohne verwertbaren Namen', () => {
  it('sind uebersprungen und kein Fehler', () => {
    const summary = importParsedFile(
      parsedFile(
        ['Name', 'Firma'],
        [{ Name: '', Firma: 'Acme' }, { Name: '   ', Firma: 'Beta' }, { Name: 'Clara Zeta', Firma: 'Zeta' }],
      ),
    );

    expect(counts(summary)).toEqual([1, 0, 2, 0]);
    expect(summary.rows[0]?.outcome).toBe('skipped');
    expect(summary.rows[0]?.reason).toBe('kein verwertbarer Name in der Zeile');
  });
});

describe('Dubletten innerhalb derselben Datei', () => {
  it('werden erkannt, obwohl sie beim Aufbau des Index noch nicht in der Datenbank standen', () => {
    const summary = importParsedFile(
      parsedFile(
        ['Name', 'E-Mail', 'Firma'],
        [
          { Name: 'Anna Schmidt', 'E-Mail': '', Firma: '' },
          { Name: 'ANNA  SCHMIDT', 'E-Mail': 'anna@example.com', Firma: 'Acme' },
        ],
      ),
    );

    expect(counts(summary)).toEqual([1, 1, 0, 0]);
    expect(summary.rows[1]?.matchedBy).toBe('name');
    expect(getAllContactsForDedup()).toHaveLength(1);
  });
});

describe('Ergaenzen bestehender Kontakte', () => {
  it('fuellt leere Felder und laesst gepflegte stehen', () => {
    const existing = createContact({
      name: 'Paul Brandner',
      status: 'active',
      title: 'Partner',
      linkedin_url: 'https://www.linkedin.com/in/paulbrandner',
    });

    const summary = importParsedFile(
      parsedFile(
        ['Name', 'URL', 'E-Mail', 'Position'],
        [
          {
            Name: 'Paul Brandner',
            URL: 'http://linkedin.com/in/paulbrandner/?utm_source=share',
            'E-Mail': 'paul@example.com',
            Position: 'General Partner',
          },
        ],
      ),
      // Eine von Hand gesetzte Zuordnung, weil 'URL' ohne LinkedIn-Layout
      // absichtlich nicht automatisch zur Profil-URL wird.
      {
        mapping: {
          Name: { kind: 'field', field: 'name' },
          URL: { kind: 'field', field: 'linkedin_url' },
          'E-Mail': { kind: 'field', field: 'email' },
          Position: { kind: 'field', field: 'title' },
        },
      },
    );

    expect(counts(summary)).toEqual([0, 1, 0, 0]);
    expect(summary.rows[0]?.matchedBy).toBe('linkedin_url');

    const after = getContact(existing.id);
    expect(after?.email).toBe('paul@example.com');
    expect(after?.title).toBe('Partner');
    // enrichContact ruehrt den Status nicht an: aus einem gepflegten Kontakt
    // macht ein Import keinen importierten.
    expect(after?.status).toBe('active');
  });

  it('fuellt die leere Stadt und laesst die gepflegte Firma stehen', () => {
    const existing = createContact({
      name: 'Nora Haugen',
      status: 'active',
      company: 'Equinor',
    });
    expect(existing.city).toBeNull();

    const summary = importParsedFile(
      parsedFile(
        ['Name', 'Firma', 'Ort'],
        [{ Name: 'Nora Haugen', Firma: 'Statoil ASA', Ort: 'Stavanger' }],
      ),
    );

    expect(counts(summary)).toEqual([0, 1, 0, 0]);
    expect(summary.rows[0]?.matchedBy).toBe('name');

    const after = getContact(existing.id);
    expect(after?.city).toBe('Stavanger');
    expect(after?.company).toBe('Equinor');
    expect(getAllContactsForDedup()).toHaveLength(1);
  });

  it('zaehlt einen Treffer ohne neue Information als uebersprungen', () => {
    createContact({ name: 'Clara Zeta', email: 'clara@example.com', company: 'Zeta AG' });

    const summary = importParsedFile(
      parsedFile(['Name', 'E-Mail', 'Firma'], [{ Name: 'clara zeta', 'E-Mail': '', Firma: 'Zeta AG' }]),
    );

    expect(counts(summary)).toEqual([0, 0, 1, 0]);
    expect(summary.rows[0]?.reason).toBe('nichts zu ergänzen');
  });
});

describe('Fehlerhafte Zeilen', () => {
  it('werden mit Grund protokolliert, ohne die gesunden Zeilen mitzureissen', () => {
    const summary = importParsedFile(
      parsedFile(
        ['Name', 'Firma'],
        [{ Name: 'X'.repeat(250), Firma: 'Acme' }, { Name: 'Heinz Klein', Firma: 'Klein GmbH' }],
      ),
    );

    expect(counts(summary)).toEqual([1, 0, 0, 1]);
    expect(summary.rows[0]?.outcome).toBe('error');
    expect(summary.rows[0]?.reason).toContain('name');
    expect(getAllContactsForDedup()).toHaveLength(1);
  });
});

describe('Quelle', () => {
  it('faellt ohne Angabe auf linkedin, wenn das Layout erkannt wurde, sonst auf csv', () => {
    importParsedFile(parseFile(FIXTURE));
    expect(getContact(getAllContactsForDedup()[0]?.id ?? 0)?.source).toBe('linkedin');

    resetContacts();
    importParsedFile(parsedFile(['Name'], [{ Name: 'Clara Zeta' }]));
    expect(getContact(getAllContactsForDedup()[0]?.id ?? 0)?.source).toBe('csv');
  });

  it('nimmt eine ausdrueckliche Angabe des Aufrufers', () => {
    importParsedFile(parsedFile(['Name'], [{ Name: 'Clara Zeta' }]), { source: 'manual' });
    expect(getContact(getAllContactsForDedup()[0]?.id ?? 0)?.source).toBe('manual');
  });
});

describe('Harter Abbruch mitten im Lauf', () => {
  const FUENF_ZEILEN = parsedFile(
    ['Name', 'Firma'],
    [
      { Name: 'Erste Person', Firma: 'Eins GmbH' },
      { Name: 'Zweite Person', Firma: 'Zwei GmbH' },
      { Name: 'Dritte Person', Firma: 'Drei GmbH' },
      { Name: 'Vierte Person', Firma: 'Vier GmbH' },
      { Name: 'Fuenfte Person', Firma: 'Fuenf GmbH' },
    ],
  );

  it('hinterlaesst keine halb importierte Datei', () => {
    const bestand = createContact({ name: 'Bestandsperson Ohne Bezug', status: 'active' });
    crash.atFindCall = 3;

    expect(() => importParsedFile(FUENF_ZEILEN)).toThrow(/simulierter Abbruch/u);

    // Die beiden Zeilen vor dem Abbruch waren bereits geschrieben. Nach dem
    // Rollback ist keine davon uebrig: bei 900 Kontakten ist ein halber Import
    // schlimmer als gar keiner, weil niemand weiss, wo er stand.
    expect(getAllContactsForDedup().map((contact) => contact.id)).toEqual([bestand.id]);
    expect(listContacts({ status: 'imported' })).toHaveLength(0);
  });

  it('laesst denselben Import danach vollstaendig durchlaufen', () => {
    crash.atFindCall = 3;
    expect(() => importParsedFile(FUENF_ZEILEN)).toThrow();

    // Kein Rest aus dem abgebrochenen Lauf: der Wiederholungslauf legt alle
    // fuenf an und nicht etwa nur die drei, die beim ersten Mal fehlten.
    crash.atFindCall = 0;
    expect(counts(importParsedFile(FUENF_ZEILEN))).toEqual([5, 0, 0, 0]);
    expect(getAllContactsForDedup()).toHaveLength(5);
  });
});

describe('Namensvettern werden nicht verschmolzen', () => {
  it('legt zwei Profile mit gleichem Namen und verschiedener URL getrennt an', () => {
    // Der teuerste Fehler des Imports: zwei Menschen, ein Datensatz. Person 2
    // verlaere URL, Firma und Titel, waehrend ihre E-Mail auf Person 1 landet -
    // und nichts davon waere in der Bilanz zu sehen.
    const summary = importParsedFile(
      parsedFile(
        ['First Name', 'Last Name', 'URL', 'Email Address', 'Company', 'Position'],
        [
          {
            'First Name': 'Anna',
            'Last Name': 'Schmidt',
            URL: 'https://www.linkedin.com/in/anna-schmidt-berlin',
            'Email Address': '',
            Company: 'Acme',
            Position: 'CTO',
          },
          {
            'First Name': 'Anna',
            'Last Name': 'Schmidt',
            URL: 'https://www.linkedin.com/in/anna-schmidt-muenchen',
            'Email Address': 'anna.zwei@example.com',
            Company: 'Beta AG',
            Position: 'Head of Legal',
          },
        ],
      ),
      { source: 'linkedin' },
    );

    expect(counts(summary)).toEqual([2, 0, 0, 0]);
    expect(contactsNamed('Anna Schmidt')).toHaveLength(2);

    const ids = summary.rows.map((row) => row.contactId ?? 0);
    const erste = getContact(ids[0] ?? 0);
    const zweite = getContact(ids[1] ?? 0);

    expect(erste?.linkedin_url).toBe('https://www.linkedin.com/in/anna-schmidt-berlin');
    expect(erste?.email).toBeNull();
    expect(zweite?.linkedin_url).toBe('https://www.linkedin.com/in/anna-schmidt-muenchen');
    expect(zweite?.email).toBe('anna.zwei@example.com');
    expect(zweite?.company).toBe('Beta AG');
    expect(zweite?.title).toBe('Head of Legal');
  });

  it('schreibt bei einem Treffer nur ueber den Namen keine Identitaetsfelder', () => {
    // Der bestehende Kontakt hat weder E-Mail noch URL, die Zeile trifft ihn
    // also ueber den Namen. Wuerden E-Mail und URL der fremden Person
    // geschrieben, griffe ab dem naechsten Lauf Stufe 1 auf denselben Kontakt -
    // der Fehler waere danach von einem echten Treffer nicht zu unterscheiden.
    const berlin = createContact({
      name: 'Anna Schmidt',
      status: 'active',
      city: 'Berlin',
      company: 'Berliner Verlag',
    });

    const datei = parsedFile(
      ['Name', 'URL', 'E-Mail', 'Position'],
      [
        {
          Name: 'Anna Schmidt',
          URL: 'https://www.linkedin.com/in/anna-schmidt-kiel',
          'E-Mail': 'anna.schmidt@kiel-werft.de',
          Position: 'Werkleiterin',
        },
      ],
    );
    const mapping: ColumnMapping = {
      Name: { kind: 'field', field: 'name' },
      URL: { kind: 'field', field: 'linkedin_url' },
      'E-Mail': { kind: 'field', field: 'email' },
      Position: { kind: 'field', field: 'title' },
    };

    const summary = importParsedFile(datei, { mapping });
    expect(summary.rows[0]?.matchedBy).toBe('name');

    const after = getContact(berlin.id);
    expect(after?.email).toBeNull();
    expect(after?.linkedin_url).toBeNull();
    // Was keine Identitaet ist, wird weiterhin ergaenzt.
    expect(after?.title).toBe('Werkleiterin');
    expect(after?.company).toBe('Berliner Verlag');

    // Und der Lauf bleibt idempotent: der zweite Durchgang legt nichts an und
    // sagt, warum er nichts uebernommen hat.
    const second = importParsedFile(datei, { mapping });
    expect(counts(second)).toEqual([0, 0, 1, 0]);
    expect(second.rows[0]?.reason).toBe(
      'nur über den Namen zugeordnet, E-Mail und Profil-URL wurden nicht übernommen',
    );
    expect(getAllContactsForDedup()).toHaveLength(1);
  });
});

describe('Verworfene Werte stehen in der Bilanz', () => {
  it('meldet ein unlesbares Datum, statt still den Importzeitpunkt zu setzen', () => {
    const summary = importParsedFile(
      parsedFile(
        ['Name', 'Connected On'],
        [
          { Name: 'Us Ulrich', 'Connected On': '03/14/2023' },
          { Name: 'Leer Lena', 'Connected On': '' },
          { Name: 'Text Theo', 'Connected On': '14 Mar 2023' },
        ],
      ),
    );

    expect(counts(summary)).toEqual([3, 0, 0, 0]);
    // Nur die unlesbare Zeile wird gemeldet - die leere Zelle sagt nichts aus.
    expect(summary.rows[0]?.dropped).toEqual([
      { field: 'created_at', value: '03/14/2023', reason: 'unlesbares Datum' },
    ]);
    expect(summary.rows[1]?.dropped).toBeUndefined();
    expect(summary.rows[2]?.dropped).toBeUndefined();

    const theo = getContact(summary.rows[2]?.contactId ?? 0);
    expect(theo?.created_at).toBe('2023-03-14');
  });

  it('speichert einen Platzhalter nicht als E-Mail-Adresse', () => {
    const summary = importParsedFile(
      parsedFile(['Name', 'E-Mail'], [{ Name: 'Test Platzhalter', 'E-Mail': 'n/a' }]),
    );

    expect(summary.rows[0]?.dropped).toEqual([
      { field: 'email', value: 'n/a', reason: 'keine E-Mail-Adresse' },
    ]);
    expect(getContact(summary.rows[0]?.contactId ?? 0)?.email).toBeNull();
  });
});

describe('Eine Spalte namens __proto__', () => {
  it('geht auf dem Weg durch die Validierung nicht verloren', () => {
    // Beim Upload in Meilenstein 3 stammt die Kopfzeile nicht zwingend vom
    // Nutzer selbst. Landete der Wert auf dem Prototype-Setter, waere der Name
    // spurlos weg und die Zeile hiesse "kein verwertbarer Name" - mit einer
    // Bilanz, die plausibel aussieht.
    const row: RawRow = Object.create(null) as RawRow;
    row['__proto__'] = 'Anna Meier';
    row['E-Mail'] = 'anna@example.com';

    const summary = importParsedFile(parsedFile(['__proto__', 'E-Mail'], [row]), {
      // Computed Key: `__proto__:` im Objektliteral waere die
      // Prototyp-Kurzschreibweise und gar kein Eintrag.
      mapping: {
        ['__proto__']: { kind: 'field', field: 'name' },
        'E-Mail': { kind: 'field', field: 'email' },
      },
    });

    expect(counts(summary)).toEqual([1, 0, 0, 0]);
    expect(getContact(summary.rows[0]?.contactId ?? 0)?.name).toBe('Anna Meier');
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });
});

describe('Was der Import schreibt, findet die Query-Schicht wieder', () => {
  it('speichert die LinkedIn-URL in genau der Form, die findContactByLinkedinUrl sucht', () => {
    // Der Import kanonisierte den Host frueher nur fuer seinen eigenen
    // Dublettenschluessel. Gespeichert wurde 'https://de.linkedin.com/...',
    // und jeder andere Aufrufer der Query-Schicht - also das Interface aus
    // Meilenstein 3 - fand die Zeile ueber die uebliche www-Form nicht mehr.
    const summary = importParsedFile(
      parsedFile(
        ['Name', 'URL'],
        [{ Name: 'Zoe Laender', URL: 'https://de.linkedin.com/in/zoe-laender' }],
      ),
      {
        mapping: {
          Name: { kind: 'field', field: 'name' },
          URL: { kind: 'field', field: 'linkedin_url' },
        },
      },
    );

    const id = summary.rows[0]?.contactId ?? 0;
    expect(getContact(id)?.linkedin_url).toBe('https://www.linkedin.com/in/zoe-laender');

    for (const variante of [
      'https://www.linkedin.com/in/zoe-laender',
      'https://de.linkedin.com/in/zoe-laender',
      'linkedin.com/in/zoe-laender/',
    ]) {
      expect(findContactByLinkedinUrl(variante)?.id, variante).toBe(id);
    }
  });
});
