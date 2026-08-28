import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';

import { parseBuffer, parseFile } from '@/lib/import/parse';
import type { ParsedFile } from '@/lib/import/types';

/**
 * Der Parser: aus Bytes werden Kopfzeile und Datenzeilen.
 *
 * Die teuren Fehler liegen hier nicht im Normalfall, sondern an den Raendern:
 * eine falsch gefundene Kopfzeile verschiebt die ganze Datei um eine Zeile, ein
 * verlorener Zeilenumbruch macht aus einem Kontakt zwei, und ein nicht
 * erkanntes BOM macht aus 'First Name' eine Spalte, die kein Mapping trifft.
 * Genau diese Faelle stehen unten - der Normalfall ist nur der erste Block.
 *
 * Die Excel-Dateien entstehen im Test selbst. Eine Binaerdatei im Repo koennte
 * niemand nachvollziehbar aendern, und was in ihr steht, waere nicht lesbar.
 */

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const LINKEDIN_FIXTURE = path.join(FIXTURE_DIR, 'linkedin-connections.csv');

const LINKEDIN_HEADERS = [
  'First Name',
  'Last Name',
  'URL',
  'Email Address',
  'Company',
  'Position',
  'Connected On',
];

/** Kurzform: Text als CSV parsen, ohne dafuer eine Datei anzulegen. */
function csv(text: string, filename = 'kontakte.csv'): ParsedFile {
  return parseBuffer(Buffer.from(text, 'utf8'), filename);
}

/**
 * Der Teil eines ParsedFile, der bei CSV und Excel gleich sein MUSS. format und
 * sheetName unterscheiden sich naturgemaess und bleiben deshalb draussen.
 */
function shape(parsed: ParsedFile): Pick<ParsedFile, 'headers' | 'rows' | 'preambleLines'> {
  return { headers: parsed.headers, rows: parsed.rows, preambleLines: parsed.preambleLines };
}

/** Eine Arbeitsmappe aus Zellwerten, als Buffer - wie sie ein Upload liefern wuerde. */
function workbook(
  cells: string[][],
  bookType: 'xlsx' | 'xls',
  sheetName = 'Verbindungen',
): Buffer {
  const sheet = XLSX.utils.aoa_to_sheet(cells);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, sheetName);

  const written: unknown = XLSX.write(book, { type: 'buffer', bookType });
  if (!Buffer.isBuffer(written)) {
    throw new Error('SheetJS hat keinen Buffer geliefert.');
  }
  return written;
}

/** Ein ParsedFile zurueck in Zellwerte - Grundlage der Excel-Gegenprobe. */
function toCells(parsed: ParsedFile, preamble: string[][]): string[][] {
  return [
    ...preamble,
    parsed.headers,
    ...parsed.rows.map((row) => parsed.headers.map((header) => row[header] ?? '')),
  ];
}

describe('Der echte LinkedIn-Export', () => {
  const parsed = parseFile(LINKEDIN_FIXTURE);

  it('ueberspringt die drei Zeilen Praeambel und findet die sieben Spalten', () => {
    expect(parsed.preambleLines).toBe(3);
    expect(parsed.headers).toEqual(LINKEDIN_HEADERS);
    expect(parsed.rows).toHaveLength(40);
    expect(parsed.format).toBe('csv');
    expect(parsed.sheetName).toBeUndefined();
  });

  it('liest die erste und die letzte Datenzeile vollstaendig', () => {
    // Erste und letzte Zeile zusammen belegen, dass weder vorn eine Zeile
    // verschluckt noch hinten eine angehaengt wurde.
    expect(parsed.rows[0]).toEqual({
      'First Name': 'Paul',
      'Last Name': 'Brandner',
      URL: 'https://www.linkedin.com/in/paulbrandner',
      'Email Address': '',
      Company: 'Alpine Health Ventures',
      Position: 'Partner',
      'Connected On': '14 Mar 2023',
    });
    expect(parsed.rows[39]?.['Last Name']).toBe('Rothe');
  });

  it('haelt den Zeilenumbruch innerhalb eines Feldes zusammen', () => {
    // Ein split('\n') wuerde aus Zoe Williams zwei kaputte Zeilen machen und
    // damit alle folgenden Zeilennummern verschieben.
    const zoe = parsed.rows.find((row) => row['First Name'] === 'Zoe');
    expect(zoe?.Company).toBe('Anthropic\nPBC');
    expect(zoe?.Position).toBe('Recruiter');
  });

  it('behaelt Kommas innerhalb gequoteter Felder', () => {
    const positions = parsed.rows.map((row) => row['Position']);
    expect(positions).toContain('Head of Engineering, Diagnostics');
    expect(positions).toContain('Lead Designer, Maps & Navigation');
    expect(parsed.rows.map((row) => row['Company'])).toContain('Berger, Meier & Partner GmbH');
  });

  it('laesst Rand-Leerzeichen der Werte stehen', () => {
    // Getrimmt wird erst in applyMapping. Wuerde der Parser hier eingreifen,
    // koennte niemand mehr nachvollziehen, was in der Datei stand.
    const raw = parsed.rows[29];
    expect(raw?.['First Name']).toBe('  Lena  ');
    expect(raw?.['Last Name']).toBe('  Schmidt  ');
  });

  it('liefert aus dem Buffer dasselbe wie aus dem Dateipfad', () => {
    // parseFile delegiert an parseBuffer - der Upload in Meilenstein 3 nimmt
    // damit denselben Weg wie die CLI.
    const fromBuffer = parseBuffer(readFileSync(LINKEDIN_FIXTURE), 'linkedin-connections.csv');
    expect(fromBuffer).toEqual(parsed);
  });
});

describe('Gequotete Felder', () => {
  it('gibt ein verdoppeltes Anfuehrungszeichen als einfaches zurueck', () => {
    const parsed = csv('Name,Firma\nAnna,"Say ""Hallo"" GmbH"\n');
    expect(parsed.rows[0]?.['Firma']).toBe('Say "Hallo" GmbH');
  });

  it('behaelt den Trenner selbst, wenn er im Feld steht', () => {
    const parsed = csv('Name;Firma\nAnna;"Meier; Sohn"\n');
    expect(parsed.rows[0]?.['Firma']).toBe('Meier; Sohn');
  });
});

describe('Die Kopfzeile wird gesucht, nicht abgezaehlt', () => {
  const HEADER = 'Vorname,Nachname,E-Mail';
  const DATA = 'Anna,Schmidt,anna@example.com';

  /** Dieselbe Tabelle mit unterschiedlich langer Praeambel davor. */
  function withPreamble(lines: readonly string[]): ParsedFile {
    return csv([...lines, HEADER, DATA, ''].join('\n'));
  }

  it('kommt ohne Praeambel aus', () => {
    const parsed = withPreamble([]);
    expect(parsed.preambleLines).toBe(0);
    expect(parsed.headers).toEqual(['Vorname', 'Nachname', 'E-Mail']);
  });

  it('findet die Kopfzeile bei 1 und bei 7 Zeilen Vorspann', () => {
    // Die Zahl 3 aus dem LinkedIn-Export darf nirgends festverdrahtet sein.
    expect(withPreamble(['Export aus dem CRM']).preambleLines).toBe(1);

    const sieben = withPreamble([
      'Hinweis:',
      'Diese Datei wurde automatisch erzeugt.',
      '',
      'Stand: gestern',
      '',
      'Bitte nicht von Hand bearbeiten.',
      '',
    ]);
    expect(sieben.preambleLines).toBe(7);
  });

  it('liefert bei jeder Praeambellaenge dieselben Datenzeilen', () => {
    const ohne = withPreamble([]);
    const mit = withPreamble(['Hinweis:', 'Zeile zwei', '']);

    expect(mit.rows).toEqual(ohne.rows);
    expect(mit.headers).toEqual(ohne.headers);
  });

  it('erkennt die LinkedIn-Kopfzeile auch tief in der Datei', () => {
    const parsed = csv(
      ['Notes:', '', '', '', '', 'First Name,Last Name,Company', 'Paul,Brandner,Alpine'].join('\n'),
    );
    expect(parsed.preambleLines).toBe(5);
    expect(parsed.rows).toHaveLength(1);
  });
});

describe('Kodierung und Zeilenenden', () => {
  it('entfernt das UTF-8-BOM aus dem ersten Spaltennamen', () => {
    // Bliebe es stehen, hiesse die Spalte "﻿First Name" und wuerde von
    // keinem Mapping getroffen - der haeufigste Excel-Export ueberhaupt.
    const parsed = csv('﻿First Name,Last Name\nPaul,Brandner\n');

    expect(parsed.headers).toEqual(['First Name', 'Last Name']);
    expect(parsed.headers[0]?.charCodeAt(0)).toBe('F'.charCodeAt(0));
    expect(parsed.rows[0]).toEqual({ 'First Name': 'Paul', 'Last Name': 'Brandner' });
  });

  it('liest eine als "Unicode Text" gespeicherte CSV', () => {
    // Diese Variante bietet Excel neben der UTF-8-CSV an; ohne Behandlung des
    // UTF-16-BOM stuenden zwischen allen Zeichen NUL-Bytes.
    const parsed = parseBuffer(
      Buffer.from('﻿Vorname,Nachname\nJürgen,Müller\n', 'utf16le'),
      'unicode.csv',
    );

    expect(parsed.headers).toEqual(['Vorname', 'Nachname']);
    expect(parsed.rows[0]).toEqual({ Vorname: 'Jürgen', Nachname: 'Müller' });
  });

  it('liest CRLF wie LF', () => {
    const crlf = csv('Vorname,Nachname\r\nAnna,Schmidt\r\nBert,Meier\r\n');
    const lf = csv('Vorname,Nachname\nAnna,Schmidt\nBert,Meier\n');

    expect(shape(crlf)).toEqual(shape(lf));
    expect(crlf.rows[1]?.['Nachname']).toBe('Meier');
  });

  it('kommt mit einem Semikolon-Export aus zwei Spalten zurecht', () => {
    // Excel im deutschen Gebietsschema trennt mit Semikolon und schliesst mit
    // einem Zeilenumbruch ab. Zaehlt der beim Raten des Trenners als Zeile,
    // rutscht der Schnitt unter zwei Felder und die Datei wird einspaltig
    // gelesen - siehe withoutTrailingBlankLines in parse.ts.
    const parsed = csv('Name;E-Mail\nAnna Schmidt;anna@example.com\n');

    expect(parsed.headers).toEqual(['Name', 'E-Mail']);
    expect(parsed.rows[0]?.['E-Mail']).toBe('anna@example.com');
  });
});

describe('Excel', () => {
  const fromCsv = parseFile(LINKEDIN_FIXTURE);
  const preamble = [
    ['Notes:'],
    ['Beim Export fehlen die meisten E-Mail-Adressen; das ist keine Panne, sondern eine Einstellung.'],
    [''],
  ];

  it.each(['xlsx', 'xls'] as const)(
    'liest eine %s-Mappe zu demselben ParsedFile wie die CSV',
    (bookType) => {
      const parsed = parseBuffer(
        workbook(toCells(fromCsv, preamble), bookType),
        `connections.${bookType}`,
      );

      expect(parsed.format).toBe(bookType);
      expect(parsed.sheetName).toBe('Verbindungen');
      // Der eigentliche Punkt: Kopfzeile, Praeambellaenge und alle 40 Zeilen
      // sind identisch - inklusive des Zeilenumbruchs in "Anthropic\nPBC" und
      // der Rand-Leerzeichen bei "  Lena  ".
      expect(shape(parsed)).toEqual(shape(fromCsv));
    },
  );

  it.each(['xlsx', 'xls'] as const)('nennt bei %s das gelesene Arbeitsblatt', (bookType) => {
    const parsed = parseBuffer(
      workbook([['Name', 'Ort'], ['Anna', 'Wien']], bookType, 'Blatt 1'),
      `kontakte.${bookType}`,
    );

    expect(parsed.sheetName).toBe('Blatt 1');
    expect(parsed.rows).toEqual([{ Name: 'Anna', Ort: 'Wien' }]);
  });

  it('haelt eine Zahl als Text fest, statt sie umzurechnen', () => {
    // raw: false ist der Grund - sonst wird '14 Mar 2023' zur Seriennummer und
    // die fuehrende Null einer Telefonnummer verschwindet.
    const parsed = parseBuffer(
      workbook([['Name', 'Telefon'], ['Anna', '004312345']], 'xlsx'),
      'kontakte.xlsx',
    );
    expect(parsed.rows[0]?.['Telefon']).toBe('004312345');
  });

  it('weist eine Mappe zurueck, die sich als CSV ausgibt', () => {
    // Sonst landet eine ZIP-Signatur als eine Zeile Binaermuell im Parser und
    // erzeugt 40 unbrauchbare Kontakte.
    expect(() => parseBuffer(workbook([['Name'], ['Anna']], 'xlsx'), 'falsch.csv')).toThrow(
      /Excel-Arbeitsmappe/u,
    );
  });
});

describe('Doppelte Spaltennamen', () => {
  it('haelt beide Spalten auseinander, statt die erste zu ueberschreiben', () => {
    const parsed = csv('Name,E-Mail,E-Mail\nAnna,dienstlich@example.com,privat@example.com\n');

    expect(parsed.headers).toEqual(['Name', 'E-Mail', 'E-Mail (2)']);
    expect(parsed.rows[0]).toEqual({
      Name: 'Anna',
      'E-Mail': 'dienstlich@example.com',
      'E-Mail (2)': 'privat@example.com',
    });
  });

  it('haelt sie auch in einer Excel-Mappe auseinander', () => {
    const parsed = parseBuffer(
      workbook([['Name', 'E-Mail', 'E-Mail'], ['Anna', 'a@example.com', 'b@example.com']], 'xlsx'),
      'doppelt.xlsx',
    );
    expect(parsed.headers).toEqual(['Name', 'E-Mail', 'E-Mail (2)']);
    expect(parsed.rows[0]?.['E-Mail (2)']).toBe('b@example.com');
  });

  it('gibt einer namenlosen Spalte mit Daten einen Platzhalter', () => {
    const parsed = csv('Name,,E-Mail\nAnna,Wien,anna@example.com\n');

    expect(parsed.headers).toEqual(['Name', 'Spalte 2', 'E-Mail']);
    expect(parsed.rows[0]?.['Spalte 2']).toBe('Wien');
  });

  it('laesst eine durchgehend leere Spalte weg', () => {
    // Der abschliessende Strichpunkt mancher Exporte - kein Datenverlust.
    const parsed = csv('Name;E-Mail;\nAnna;anna@example.com;\n');
    expect(parsed.headers).toEqual(['Name', 'E-Mail']);
  });
});

describe('Dateien, aus denen nichts zu holen ist', () => {
  it('sagt bei einer leeren Datei, dass keine Zeilen lesbar sind', () => {
    expect(() => csv('')).toThrow(/keine lesbaren CSV-Zeilen/u);
    expect(() => csv('\n\n\n')).toThrow(/keine lesbaren CSV-Zeilen/u);
  });

  it('nennt den Dateinamen im Fehler', () => {
    // Bei einem Stapel Dateien ist die Meldung ohne Namen wertlos.
    expect(() => csv('', 'export-2026.csv')).toThrow(/export-2026\.csv/u);
  });

  it('sagt bei einer Datei ohne Kopfzeile, was es erwartet haette', () => {
    expect(() => csv('Diese Datei ist nur ein Satz ohne jedes Trennzeichen.\n')).toThrow(
      /keine Kopfzeile gefunden/u,
    );
    // Eine Zeile aus lauter Zahlen ist eine Datenzeile, keine Kopfzeile.
    expect(() => csv('1,2,3\n4,5,6\n')).toThrow(/keine Kopfzeile gefunden/u);
  });

  it('sagt bei einer leeren Arbeitsmappe ebenfalls Bescheid', () => {
    expect(() => parseBuffer(workbook([], 'xlsx'), 'leer.xlsx')).toThrow(
      /enthaelt keine Zeilen|keine Kopfzeile gefunden/u,
    );
  });

  it('weist ein nicht unterstuetztes Format zurueck und nennt die unterstuetzten', () => {
    expect(() => csv('Name\nAnna\n', 'kontakte.txt')).toThrow(/\.csv, \.xlsx, \.xls/u);
  });

  it('meldet einen nicht lesbaren Pfad, statt undefiniert weiterzulaufen', () => {
    expect(() => parseFile(path.join(FIXTURE_DIR, 'gibt-es-nicht.csv'))).toThrow(
      /konnte nicht gelesen werden/u,
    );
  });

  it('liefert bei einer Kopfzeile ohne Datenzeilen null Zeilen und keinen Fehler', () => {
    const parsed = csv('Vorname,Nachname\n');
    expect(parsed.headers).toEqual(['Vorname', 'Nachname']);
    expect(parsed.rows).toEqual([]);
  });
});

describe('Leerzeilen zwischen den Daten', () => {
  it('zaehlen nicht als Kontakt', () => {
    // Sonst entstehen Kontakte ohne Namen, und die Zeilennummern im Protokoll
    // zeigen auf Zeilen, die niemand importieren wollte.
    const parsed = csv('Name,Ort\nAnna,Wien\n\n\nBert,Graz\n\n');

    expect(parsed.rows).toEqual([
      { Name: 'Anna', Ort: 'Wien' },
      { Name: 'Bert', Ort: 'Graz' },
    ]);
  });
});

describe('Kodierung ohne BOM', () => {
  it('liest eine Windows-1252-Datei richtig und sagt es dazu', () => {
    // "CSV (Trennzeichen-getrennt)" aus Excel im deutschen Gebietsschema. Ein
    // nachsichtiges toString('utf8') macht daraus 'J?rgen M?ller' mit
    // Ersatzzeichen - und der Schaden bleibt: enrichContact fuellt nur leere
    // Felder, ein spaeterer korrekter Import repariert den Namen also nicht.
    const bytes = Buffer.from([
      ...Buffer.from('Name;Firma\n', 'latin1'),
      ...Buffer.from('J\xfcrgen M\xfcller;Gr\xfc\xdfler GmbH\n', 'latin1'),
    ]);
    const parsed = parseBuffer(bytes, 'export.csv');

    expect(parsed.rows[0]).toEqual({ Name: 'Jürgen Müller', Firma: 'Grüßler GmbH' });
    expect(parsed.rows[0]?.['Name']).not.toContain('�');
    expect(parsed.warnings?.join(' ')).toMatch(/nicht UTF-8 kodiert/u);
  });

  it('meldet bei sauberem UTF-8 nichts', () => {
    const parsed = csv('Name;Firma\nJürgen Müller;Grüßler GmbH\n');
    expect(parsed.rows[0]).toEqual({ Name: 'Jürgen Müller', Firma: 'Grüßler GmbH' });
    expect(parsed.warnings).toBeUndefined();
  });
});

describe('Endung und Inhalt widersprechen sich', () => {
  it('liest eine Textdatei mit .xlsx-Endung als CSV, statt Mojibake zu erzeugen', () => {
    // SheetJS liest solche Bytes als CP1252: aus 'Jürgen Müller' wird
    // 'JÃ¼rgen MÃ¼ller', ohne Fehler und ohne Warnung. Die Datei ist aber
    // lesbar - abbrechen waere unnoetig streng, still verstuemmeln falsch.
    const parsed = parseBuffer(
      Buffer.from('Name;E-Mail;Firma\nJürgen Müller;j@example.com;Schöller GmbH\n', 'utf8'),
      'export.xlsx',
    );

    expect(parsed.format).toBe('csv');
    expect(parsed.rows[0]?.['Name']).toBe('Jürgen Müller');
    expect(parsed.rows[0]?.['Firma']).toBe('Schöller GmbH');
    expect(parsed.warnings?.join(' ')).toMatch(/Endung \.xlsx.*Textdatei/su);
  });

  it('bricht in der Gegenrichtung weiterhin ab', () => {
    // Aus einer Arbeitsmappe laesst sich als Text nichts machen - hier ist der
    // klare Fehler mehr wert als 40 unbrauchbare Kontakte.
    expect(() => parseBuffer(workbook([['Name'], ['Anna']], 'xlsx'), 'falsch.csv')).toThrow(
      /Excel-Arbeitsmappe/u,
    );
  });
});

describe('Mappen mit mehreren Arbeitsblaettern', () => {
  /** Eine Mappe aus mehreren benannten Blaettern. */
  function multi(sheets: Array<[string, string[][]]>): Buffer {
    const book = XLSX.utils.book_new();
    for (const [name, cells] of sheets) {
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(cells), name);
    }
    const written: unknown = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
    if (!Buffer.isBuffer(written)) {
      throw new Error('SheetJS hat keinen Buffer geliefert.');
    }
    return written;
  }

  const DECKBLATT_UND_DATEN: Array<[string, string[][]]> = [
    ['Deckblatt', [['Kundenliste Stand 2026']]],
    ['Kontakte', [['Name', 'Firma'], ['Blatt Zwei', 'Acme']]],
    ['Anhang', [['Hinweise']]],
  ];

  it('nimmt das erste Blatt mit einer Kopfzeile, statt am Deckblatt zu scheitern', () => {
    const parsed = parseBuffer(multi(DECKBLATT_UND_DATEN), 'kunden.xlsx');

    expect(parsed.sheetName).toBe('Kontakte');
    expect(parsed.rows).toEqual([{ Name: 'Blatt Zwei', Firma: 'Acme' }]);
    expect(parsed.warnings?.join(' ')).toContain('"Deckblatt"');
  });

  it('kommt auch an einem leeren ersten Blatt vorbei', () => {
    const parsed = parseBuffer(
      multi([
        ['Deckblatt', [[]]],
        ['Kontakte', [['Name', 'Firma'], ['Blatt Zwei', 'Acme']]],
      ]),
      'kunden.xlsx',
    );

    expect(parsed.sheetName).toBe('Kontakte');
    expect(parsed.rows).toHaveLength(1);
  });

  it('nimmt das ausdruecklich gewaehlte Blatt, per Name und per Nummer', () => {
    const buffer = multi(DECKBLATT_UND_DATEN);

    expect(parseBuffer(buffer, 'kunden.xlsx', { sheet: 'Kontakte' }).sheetName).toBe('Kontakte');
    expect(parseBuffer(buffer, 'kunden.xlsx', { sheet: 2 }).sheetName).toBe('Kontakte');
    expect(parseBuffer(buffer, 'kunden.xlsx', { sheet: '2' }).sheetName).toBe('Kontakte');
  });

  it('nennt bei einer unbekannten Wahl die vorhandenen Blaetter', () => {
    // Ohne die Liste ist --sheet nicht bedienbar: der Nutzer sieht die
    // Blattnamen ja nirgends.
    expect(() =>
      parseBuffer(multi(DECKBLATT_UND_DATEN), 'kunden.xlsx', { sheet: 'Gibtesnicht' }),
    ).toThrow(/"Deckblatt", "Kontakte", "Anhang"/u);
  });

  it('nennt sie auch, wenn kein einziges Blatt taugt', () => {
    expect(() =>
      parseBuffer(
        multi([
          ['Deckblatt', [['Kundenliste Stand 2026']]],
          ['Anhang', [['Hinweise']]],
        ]),
        'kunden.xlsx',
      ),
    ).toThrow(/Vorhandene Arbeitsblaetter: "Deckblatt", "Anhang"/u);
  });
});

describe('Eine Spalte namens __proto__', () => {
  it('landet als eigener Schluessel in der Zeile, statt spurlos zu verschwinden', () => {
    // Trifft die Zuweisung den Prototype-Setter, meldet headers die Spalte,
    // die Zeile hat sie aber nicht - und ein Kontakt gilt als "Zeile ohne
    // Namen", obwohl sein Name in der Datei steht.
    const parsed = csv('__proto__,E-Mail\nAnna Meier,anna@example.com\n');

    expect(parsed.headers).toEqual(['__proto__', 'E-Mail']);
    expect(Object.hasOwn(parsed.rows[0] ?? {}, '__proto__')).toBe(true);
    expect(parsed.rows[0]?.['__proto__']).toBe('Anna Meier');
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });
});
