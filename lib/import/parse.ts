/**
 * Schritt 1 des Imports: aus einer Datei (.csv, .xlsx, .xls) ein ParsedFile
 * machen - Kopfzeile, Datenzeilen, Anzahl der uebersprungenen Praeambelzeilen.
 *
 * Diese Datei deutet nichts. Sie entscheidet nur, welche Zeile die Kopfzeile
 * ist und welche Spalten es gibt; was ein Wert bedeutet, klaeren mapping.ts und
 * normalize.ts. Zellwerte bleiben deshalb woertlich stehen (auch mit Rand-
 * Leerzeichen), nur Headernamen werden aufgeraeumt.
 *
 * parseFile liest die Datei und delegiert an parseBuffer. Die gesamte Logik
 * haengt am Buffer, damit der Upload im Interface (Meilenstein 3) denselben
 * Weg nimmt wie die CLI und nicht am Dateisystem haengt.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import Papa from 'papaparse';
import * as XLSX from 'xlsx';

import type { ParsedFile, RawRow } from './types';

/**
 * So viele Zeilen am Dateianfang werden nach der Kopfzeile abgesucht. Der
 * LinkedIn-Export braucht 4 (drei Zeilen Praeambel), 15 laesst Luft fuer
 * andere Exporte mit Logo-, Filter- oder Datumszeilen davor, ohne dass die
 * Suche in einer Datei ohne jede Kopfzeile bis Zeile 1000 weiterlaeuft.
 */
const HEADER_SEARCH_LIMIT = 15;

/**
 * Laengste Zeichenkette, die noch als Spaltenueberschrift durchgeht. Der
 * Erklaertext im LinkedIn-Export hat ueber 300 Zeichen, echte Ueberschriften
 * liegen weit darunter.
 */
const MAX_HEADER_CELL_LENGTH = 60;

/** Was der Header einer LinkedIn-Verbindungsliste in jedem Fall enthaelt. */
const LINKEDIN_HEADER_MARKER = 'first name';

const SUPPORTED_EXTENSIONS: Record<string, ParsedFile['format']> = {
  '.csv': 'csv',
  '.xlsx': 'xlsx',
  '.xls': 'xls',
};

/** Eine Tabelle als reine Zeichenketten - das gemeinsame Zwischenformat von CSV und Excel. */
type Grid = string[][];

/**
 * Was der Aufrufer ueber die Datei hinaus steuern kann.
 *
 * Der Kontrakt legt parseFile(filePath) und parseBuffer(buffer, filename) fest;
 * dieses Argument ist optional und laesst beide Signaturen unveraendert
 * gueltig. Es gibt genau eine Option, und die braucht jede Mappe mit mehr als
 * einem Blatt: welches davon gemeint ist.
 */
export interface ParseOptions {
  /**
   * Arbeitsblatt einer Excel-Mappe: Name (exakt) oder 1-basierter Index als
   * Zahl bzw. Zahlwort. Ohne Angabe nimmt parse.ts das erste Blatt, aus dem
   * sich eine Kopfzeile lesen laesst.
   */
  sheet?: string | number;
}

export function parseFile(filePath: string, options: ParseOptions = {}): ParsedFile {
  let buffer: Buffer;
  try {
    buffer = readFileSync(filePath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Datei konnte nicht gelesen werden: ${filePath} (${reason})`);
  }
  return parseBuffer(buffer, path.basename(filePath), options);
}

export function parseBuffer(
  buffer: Buffer,
  filename: string,
  options: ParseOptions = {},
): ParsedFile {
  const { format, warnings } = detectFormat(buffer, filename);

  if (format === 'csv') {
    const decoded = decodeText(buffer);
    return buildParsedFile(
      parseCsvGrid(decoded.text, filename),
      format,
      filename,
      undefined,
      [...warnings, ...decoded.warnings],
    );
  }

  const sheet = parseSheetGrid(buffer, filename, options.sheet);
  return buildParsedFile(sheet.grid, format, filename, sheet.sheetName, [
    ...warnings,
    ...sheet.warnings,
  ]);
}

// ---------------------------------------------------------------------------
// Format und Kodierung
// ---------------------------------------------------------------------------

/**
 * Das Format kommt aus der Dateiendung - beim Upload ist der Dateiname das
 * einzige, was der Browser ueber den Typ verraet.
 *
 * Der Dateianfang entscheidet mit, und zwar in BEIDE Richtungen:
 *
 *   - Eine .csv, die in Wahrheit eine Arbeitsmappe ist (ZIP-Signatur "PK" bei
 *     xlsx, OLE-Signatur bei xls), landet sonst als eine Zeile Binaermuell im
 *     Parser. Das ist ein Abbruch: aus den Bytes laesst sich als Text nichts
 *     Sinnvolles machen, und ein klarer Fehler ist mehr wert als 40
 *     unbrauchbare Kontakte.
 *   - Eine .xlsx oder .xls, die in Wahrheit eine Textdatei ist (so exportieren
 *     etliche Werkzeuge, und Nutzer benennen Dateien um), gaebe SheetJS als
 *     CP1252 gelesenen Text zurueck: aus 'Jürgen Müller' wird 'JÃ¼rgen MÃ¼ller',
 *     ohne Fehler und ohne Warnung. Hier wird deshalb NICHT abgebrochen,
 *     sondern auf den CSV-Weg umgeschaltet - die Datei ist ja lesbar, nur die
 *     Endung luegt. Der Hinweis darauf geht als Warnung mit.
 */
function detectFormat(
  buffer: Buffer,
  filename: string,
): { format: ParsedFile['format']; warnings: string[] } {
  const extension = path.extname(filename).toLowerCase();
  const format = SUPPORTED_EXTENSIONS[extension];

  if (format === undefined) {
    const known = Object.keys(SUPPORTED_EXTENSIONS).join(', ');
    throw new Error(
      `Nicht unterstuetztes Dateiformat "${extension || filename}". Unterstuetzt werden: ${known}.`,
    );
  }

  if (format === 'csv') {
    if (looksLikeWorkbook(buffer)) {
      throw new Error(
        `${filename} traegt die Endung .csv, ist aber eine Excel-Arbeitsmappe. ` +
          'Bitte mit der passenden Endung (.xlsx oder .xls) erneut einlesen.',
      );
    }
    return { format, warnings: [] };
  }

  if (!looksLikeWorkbook(buffer)) {
    return {
      format: 'csv',
      warnings: [
        `${filename} traegt die Endung ${extension}, ist aber keine Excel-Arbeitsmappe, ` +
          'sondern eine Textdatei. Sie wurde deshalb als CSV gelesen.',
      ],
    };
  }

  return { format, warnings: [] };
}

/** ZIP-Signatur (xlsx) oder OLE-Compound-File-Signatur (xls). */
function looksLikeWorkbook(buffer: Buffer): boolean {
  const zip = buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  const ole =
    buffer.length >= 8 &&
    buffer[0] === 0xd0 &&
    buffer[1] === 0xcf &&
    buffer[2] === 0x11 &&
    buffer[3] === 0xe0;
  return zip || ole;
}

/**
 * Bytes zu Text. Excel schreibt beim CSV-Export praktisch immer ein UTF-8-BOM,
 * gelegentlich (Variante "Unicode Text") auch UTF-16. Bliebe das BOM stehen,
 * hiesse die erste Spalte "﻿First Name" und wuerde von keinem Mapping
 * getroffen.
 *
 * Ohne BOM wird zuerst streng als UTF-8 dekodiert. Streng heisst: ein Byte, das
 * in UTF-8 nicht vorkommen kann, ist ein Fehler und kein Ersatzzeichen. Genau
 * daran haengt der haeufigste deutsche Fall - "CSV (Trennzeichen-getrennt)" aus
 * Excel schreibt Windows-1252 ohne BOM. Ein nachsichtiges toString('utf8')
 * macht daraus 'J�rgen M�ller' und importiert das kommentarlos. Der
 * Schaden bleibt: normalizePersonName faltet U+FFFD zu einem Leerzeichen, der
 * Dedup-Schluessel weicht ab, und ein spaeterer korrekter Import repariert den
 * Namen NICHT - enrichContact fuellt nur leere Felder, der kaputte Name gilt
 * als gefuellt.
 *
 * Scheitert UTF-8, wird deshalb als Windows-1252 gelesen. Das ist keine
 * Ratelotterie: Windows-1252 bildet jedes einzelne Byte auf ein Zeichen ab, es
 * ist die Standardkodierung genau der Werkzeuge, die diesen Fall erzeugen, und
 * das Ergebnis ist lesbarer Text statt Ersatzzeichen. Weil es trotzdem eine
 * Annahme bleibt, geht sie als Warnung mit nach draussen und steht in der CLI
 * vor der Rueckfrage.
 */
function decodeText(buffer: Buffer): { text: string; warnings: string[] } {
  if (buffer.length >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) {
      return { text: new TextDecoder('utf-16le').decode(buffer.subarray(2)), warnings: [] };
    }
    if (buffer[0] === 0xfe && buffer[1] === 0xff) {
      return { text: new TextDecoder('utf-16be').decode(buffer.subarray(2)), warnings: [] };
    }
  }

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return { text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, warnings: [] };
  } catch {
    return {
      text: new TextDecoder('windows-1252').decode(buffer),
      warnings: [
        'Die Datei ist nicht UTF-8 kodiert. Sie wurde als Windows-1252 gelesen ' +
          '(die uebliche Kodierung von "CSV (Trennzeichen-getrennt)" aus Excel). ' +
          'Bitte in der Vorschau pruefen, ob die Umlaute stimmen.',
      ],
    };
  }
}

// ---------------------------------------------------------------------------
// CSV und Excel zu Grid
// ---------------------------------------------------------------------------

/**
 * CSV ueber papaparse, nicht von Hand.
 *
 * Der LinkedIn-Export enthaelt Felder mit Kommas ("Head of Engineering,
 * Diagnostics"), mit Anfuehrungszeichen und mit eingebetteten Zeilenumbruechen
 * ("Anthropic\nPBC") - RFC4180 eben. Ein split(',') wuerde daran zerbrechen und
 * aus einem Kontakt zwei kaputte machen.
 *
 * skipEmptyLines bleibt aus: die Leerzeile zwischen Praeambel und Kopfzeile
 * zaehlt zu den uebersprungenen Zeilen und darf beim Zaehlen nicht fehlen.
 * Leere Datenzeilen entfernt buildParsedFile spaeter selbst.
 *
 * Der Trenner wird geraten, aber nur unter den vier ueblichen - sonst kann
 * papaparse bei schmalen Dateien auf ein Zeichen aus dem Fliesstext verfallen.
 */
function parseCsvGrid(text: string, filename: string): Grid {
  const result = Papa.parse<string[]>(withoutTrailingBlankLines(text), {
    header: false,
    skipEmptyLines: false,
    delimitersToGuess: [',', ';', '\t', '|'],
  });

  const grid = result.data.map((row) => row.map(toCell));

  if (grid.every(isEmptyRow)) {
    const firstError = result.errors[0];
    const detail = firstError === undefined ? '' : ` (${firstError.message})`;
    throw new Error(`${filename} enthaelt keine lesbaren CSV-Zeilen${detail}.`);
  }

  return grid;
}

/**
 * Leerzeilen am Dateiende abschneiden, BEVOR papaparse den Trenner raet.
 *
 * papaparse waehlt den Trenner ueber die durchschnittliche Feldzahl der ersten
 * Zeilen und verlangt dabei mehr als zwei Felder im Schnitt. Eine zweispaltige
 * Datei mit abschliessendem Zeilenumbruch kommt auf (2 + 2 + 1) / 3 = 1,67 -
 * der richtige Trenner faellt durch, papaparse weicht auf das Komma aus, und
 * aus 'Name;E-Mail' wird eine einzige Spalte. Genau so exportiert Excel im
 * deutschen Gebietsschema, also ist das kein Randfall.
 *
 * Abgeschnitten wird nur, was hinter der letzten Datenzeile steht: leere
 * Zeilen dort tragen keine Werte und wuerden ohnehin von buildParsedFile
 * entfernt. preambleLines und jede Datenzeile bleiben unberuehrt.
 *
 * Was das NICHT loest: eine zweispaltige Datei mit Praeambel. Deren einzeilige
 * Hinweiszeile drueckt den Schnitt genauso, und dagegen hilft nur ein eigener
 * Trenner-Rater. Solche Dateien scheitern weiterhin sichtbar mit "keine
 * Kopfzeile gefunden" statt still falsch gelesen zu werden.
 */
function withoutTrailingBlankLines(text: string): string {
  return text.replace(/(?:\r?\n[ \t]*)+$/u, '');
}

/**
 * Das gemeinte Arbeitsblatt einer Mappe als Grid.
 *
 * Welches Blatt gemeint ist, entscheidet sich in dieser Reihenfolge:
 *
 *   1. Die ausdrueckliche Angabe des Aufrufers (--sheet, spaeter die
 *      Auswahlliste im Upload-Dialog). Passt sie auf kein Blatt, ist das ein
 *      Fehler - inklusive der Liste der vorhandenen Blattnamen.
 *   2. Sonst das erste Blatt, aus dem sich eine Kopfzeile lesen laesst.
 *      "Deckblatt / Kontakte / Anhang" ist in Kundendateien der Normalfall;
 *      ein leeres oder kopfzeilenloses erstes Blatt darf den Import nicht
 *      beenden, solange die Daten auf Blatt 2 stehen und der Nutzer ohne
 *      Option gar nicht dorthin kaeme.
 *
 * Ein Deckblatt, das SELBST wie eine Tabelle aussieht, gewinnt weiterhin - das
 * ist von aussen nicht zu unterscheiden. Deshalb steht der gelesene Blattname
 * in jeder Ausgabe, und --sheet korrigiert den Fall.
 *
 * raw: false liefert den angezeigten Text der Zelle statt des Rohwerts. Damit
 * bleibt ein Datum "14 Mar 2023" und wird nicht zur Seriennummer 44999, und
 * eine Telefonnummer behaelt ihre fuehrende Null. defval haelt leere Zellen als
 * leeren String in der Zeile, blankrows haelt Leerzeilen drin - beides, damit
 * die Spaltenpositionen und die Zaehlung der Praeambel stimmen.
 */
function parseSheetGrid(
  buffer: Buffer,
  filename: string,
  wanted: string | number | undefined,
): { grid: Grid; sheetName: string; warnings: string[] } {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false, cellText: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${filename} konnte nicht als Arbeitsmappe gelesen werden (${reason}).`);
  }

  const names = workbook.SheetNames;
  if (names.length === 0) {
    throw new Error(`${filename} enthaelt kein Arbeitsblatt.`);
  }

  if (wanted !== undefined) {
    const sheetName = resolveSheetName(names, wanted, filename);
    const grid = sheetGrid(workbook, sheetName, filename);
    const problem = sheetProblem(grid, filename);
    if (problem !== null) {
      // Der Nutzer hat dieses Blatt ausdruecklich verlangt - dann muss die
      // Meldung sagen, welches gemeint war und welche es sonst gibt. Ohne den
      // Blattnamen sieht der Fehler aus, als taugte die ganze Datei nicht.
      throw new Error(
        `${problem} Gelesen wurde das Arbeitsblatt "${sheetName}". ` +
          `Vorhanden sind: ${names.map(quoted).join(', ')}.`,
      );
    }
    return { grid, sheetName, warnings: [] };
  }

  let firstProblem: string | null = null;
  for (const [position, sheetName] of names.entries()) {
    const grid = sheetGrid(workbook, sheetName, filename);
    const problem = sheetProblem(grid, filename);
    if (problem !== null) {
      firstProblem ??= problem;
      continue;
    }

    const warnings =
      position === 0
        ? []
        : [
            `Die ersten ${position} Arbeitsblaetter von ${filename} ` +
              `(${names.slice(0, position).map(quoted).join(', ')}) enthalten keine Kopfzeile. ` +
              `Gelesen wurde deshalb "${sheetName}". Mit --sheet laesst sich ein anderes waehlen.`,
          ];
    return { grid, sheetName, warnings };
  }

  // Kein einziges Blatt taugt. Die Meldung des ersten Blattes ist die
  // aussagekraeftigste (dort haette der Nutzer die Daten erwartet); die Liste
  // der Blattnamen kommt dazu, damit --sheet ueberhaupt bedienbar ist.
  throw new Error(
    `${firstProblem ?? `${filename} enthaelt keine Zeilen.`} ` +
      `Vorhandene Arbeitsblaetter: ${names.map(quoted).join(', ')}.`,
  );
}

/**
 * Warum dieses Blatt nicht in Frage kommt - oder null, wenn es taugt.
 *
 * Geprueft wird genau das, woran buildParsedFile sonst scheitern wuerde: keine
 * Zeilen, keine Kopfzeile. So kann die Suche ein Blatt ueberspringen, ohne dass
 * die Bedingung an zwei Stellen unterschiedlich formuliert waere.
 */
function sheetProblem(grid: Grid, filename: string): string | null {
  if (grid.length === 0 || grid.every(isEmptyRow)) {
    return `${filename} enthaelt keine Zeilen.`;
  }
  try {
    findHeaderRow(grid, filename);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function quoted(name: string): string {
  return `"${name}"`;
}

/** Ein Blattname oder ein 1-basierter Index aus der Angabe des Aufrufers. */
function resolveSheetName(
  names: readonly string[],
  wanted: string | number,
  filename: string,
): string {
  if (typeof wanted === 'string') {
    const byName = names.find((name) => name === wanted);
    if (byName !== undefined) {
      return byName;
    }
  }

  const index = typeof wanted === 'number' ? wanted : Number(wanted.trim());
  if (Number.isInteger(index) && index >= 1 && index <= names.length) {
    const byIndex = names[index - 1];
    if (byIndex !== undefined) {
      return byIndex;
    }
  }

  throw new Error(
    `${filename} hat kein Arbeitsblatt "${String(wanted)}". ` +
      `Vorhanden sind: ${names.map(quoted).join(', ')}.`,
  );
}

function sheetGrid(workbook: XLSX.WorkBook, sheetName: string, filename: string): Grid {
  const sheet = workbook.Sheets[sheetName];
  if (sheet === undefined) {
    throw new Error(`Arbeitsblatt "${sheetName}" in ${filename} ist leer.`);
  }

  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    defval: '',
    blankrows: true,
  });

  return rows.map((row) => row.map(toCell));
}

/** Jede Zelle als String, ohne null/undefined und ohne JS-Zahlen im Ergebnis. */
function toCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return typeof value === 'string' ? value : String(value);
}

// ---------------------------------------------------------------------------
// Kopfzeile finden
// ---------------------------------------------------------------------------

/**
 * Die Kopfzeile suchen statt eine feste Zahl Zeilen zu ueberspringen.
 *
 * "Ueberspringe 3" waere genau so lange richtig, wie LinkedIn seinen
 * Hinweistext nicht aendert - und falsch fuer jede andere Datei. Deshalb zwei
 * Stufen: erst der sichere Treffer ueber 'First Name', dann eine Heuristik.
 */
function findHeaderRow(grid: Grid, filename: string): number {
  const limit = Math.min(grid.length, HEADER_SEARCH_LIMIT);

  // Stufe 1: LinkedIn. 'First Name' steht in keinem Hinweistext und in keiner
  // Datenzeile, ist also ein eindeutiger Anker.
  for (let index = 0; index < limit; index += 1) {
    if (containsLinkedinMarker(grid[index] ?? [])) {
      return index;
    }
  }

  // Stufe 2: die erste Zeile, die wie eine Kopfzeile aussieht.
  for (let index = 0; index < limit; index += 1) {
    if (looksLikeHeaderRow(grid[index] ?? [])) {
      return index;
    }
  }

  throw new Error(
    `In den ersten ${limit} Zeilen von ${filename} wurde keine Kopfzeile gefunden. ` +
      'Erwartet wird entweder eine Spalte "First Name" oder eine Zeile aus kurzen, ' +
      'eindeutigen Spaltennamen.',
  );
}

function containsLinkedinMarker(row: string[]): boolean {
  return row.some((cell) => {
    const name = normalizeHeaderCell(cell).toLowerCase();
    return name === LINKEDIN_HEADER_MARKER || name.includes(LINKEDIN_HEADER_MARKER);
  });
}

/**
 * Heuristik fuer Dateien ohne 'First Name'. Eine Kopfzeile unterscheidet sich
 * von Praeambel und Daten in vier Punkten - alle vier muessen zutreffen:
 *
 *   1. Mindestens zwei befuellte Zellen. Praeambelzeilen wie "Notes:" oder ein
 *      Fliesstextabsatz stehen in genau einer Zelle.
 *   2. Keine Zelle laenger als MAX_HEADER_CELL_LENGTH. Trennt den Erklaertext
 *      von echten Ueberschriften.
 *   3. Keine rein numerische Zelle, und mindestens die Haelfte der Zellen
 *      enthaelt einen Buchstaben. "ueberwiegend kurze Textwerte": eine Zeile
 *      aus Zahlen oder Datumsangaben ist eine Datenzeile, keine Kopfzeile.
 *   4. Ueberwiegend verschiedene Werte, mindestens zwei Drittel der befuellten
 *      Zellen. Eine Datenzeile wiederholt gern denselben Wert; Spaltennamen
 *      sind in aller Regel verschieden. Bewusst kein Verbot jeder Dublette:
 *      Exporte mit zweimal "Email" gibt es wirklich, und genau die wuerde eine
 *      strikte Regel zugunsten der ersten Datenzeile verwerfen.
 *
 * Der Preis der Heuristik: eine Datei ganz ohne Kopfzeile, deren erste
 * Datenzeile zufaellig alle vier Punkte erfuellt, wird als Kopfzeile gelesen -
 * dann fehlt ein Kontakt. Das faellt im Mapping-Vorschlag auf, den der Nutzer
 * bei unbekannten Dateien ohnehin bestaetigen muss.
 */
function looksLikeHeaderRow(row: string[]): boolean {
  const filled = row.map(normalizeHeaderCell).filter((cell) => cell !== '');

  if (filled.length < 2) {
    return false;
  }
  if (filled.some((cell) => cell.length > MAX_HEADER_CELL_LENGTH)) {
    return false;
  }
  if (filled.some(isPlainNumber)) {
    return false;
  }

  const withLetter = filled.filter((cell) => /\p{L}/u.test(cell)).length;
  if (withLetter * 2 < filled.length) {
    return false;
  }

  const distinct = new Set(filled.map((cell) => cell.toLowerCase())).size;
  return distinct >= 2 && distinct * 3 >= filled.length * 2;
}

/** Zahl, Betrag oder Prozentwert - alles, was als Ueberschrift nichts zu suchen hat. */
function isPlainNumber(value: string): boolean {
  return /^[+-]?\d+(?:[.,]\d+)?\s?%?$/.test(value);
}

/**
 * Headernamen aufraeumen: Rand-Leerzeichen weg, ein umschliessendes Paar
 * Anfuehrungszeichen weg (manche Exporte quoten doppelt, dann bleibt ein
 * woertliches " im Wert stehen), und Zeilenumbrueche innerhalb einer
 * Excel-Ueberschrift zu einem Leerzeichen. Nur Header, nicht Datenzellen: die
 * Rand-Leerzeichen der Daten sind Aufgabe von normalize.ts.
 */
function normalizeHeaderCell(cell: string): string {
  const trimmed = cell.trim();
  const unquoted =
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
      ? trimmed.slice(1, -1)
      : trimmed;
  return unquoted.trim().replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// Grid zu ParsedFile
// ---------------------------------------------------------------------------

function buildParsedFile(
  grid: Grid,
  format: ParsedFile['format'],
  filename: string,
  sheetName?: string,
  warnings: readonly string[] = [],
): ParsedFile {
  if (grid.length === 0) {
    throw new Error(`${filename} enthaelt keine Zeilen.`);
  }

  const headerIndex = findHeaderRow(grid, filename);
  const headerCells = grid[headerIndex] ?? [];

  // Leerzeilen zwischen den Daten und am Dateiende fliegen raus. Sie erzeugen
  // sonst Kontakte ohne Namen, und die Zeilennummern im Protokoll zaehlen
  // dann Zeilen mit, die niemand importieren wollte.
  const dataRows = grid.slice(headerIndex + 1).filter((row) => !isEmptyRow(row));

  const columns = buildColumns(headerCells, dataRows);
  const headers = columns.map((column) => column.name);
  const rows: RawRow[] = dataRows.map((row) => {
    // Object.create(null) und nicht {}: heisst eine Spalte '__proto__', trifft
    // record[name] = wert sonst den Prototype-Setter statt eine eigene
    // Property. Der Wert verschwindet dann spurlos - headers meldet die Spalte,
    // die Zeile hat sie nicht, und ein Kontakt gilt als "Zeile ohne Namen",
    // obwohl sein Name in der Datei steht. Ohne Prototyp gibt es keinen
    // Setter, den man treffen koennte. Beim Upload in Meilenstein 3 stammt die
    // Kopfzeile nicht zwingend vom Nutzer selbst.
    const record: RawRow = Object.create(null) as RawRow;
    for (const column of columns) {
      record[column.name] = row[column.index] ?? '';
    }
    return record;
  });

  const parsed: ParsedFile = { headers, rows, preambleLines: headerIndex, format };
  if (sheetName !== undefined) {
    parsed.sheetName = sheetName;
  }
  if (warnings.length > 0) {
    parsed.warnings = [...warnings];
  }
  return parsed;
}

function isEmptyRow(row: string[]): boolean {
  return row.every((cell) => cell.trim() === '');
}

interface Column {
  /** Position in der Rohzeile. */
  index: number;
  /** Eindeutiger Name, unter dem die Spalte in RawRow steht. */
  name: string;
}

/**
 * Aus Kopfzeile und Daten die Spaltenliste bauen. Drei Faelle, die eine
 * schlichte Zuordnung "Header i -> Wert i" still falsch machen wuerden:
 *
 *   - Doppelte Namen ("Email" zweimal): der zweite ueberschriebe den ersten in
 *     RawRow. Deshalb wird er zu "Email (2)" - sichtbar im Mapping-Vorschlag,
 *     statt unbemerkt verloren.
 *   - Namenlose Spalten: haben sie Daten, bekommen sie einen Platzhalternamen
 *     und bleiben erhalten; sind sie ueberall leer (der abschliessende
 *     Strichpunkt mancher Exporte), fliegen sie raus.
 *   - Datenzeilen, die breiter sind als die Kopfzeile: die ueberzaehligen
 *     Werte bekommen ebenfalls einen Platzhalternamen, damit sie nicht
 *     stillschweigend abgeschnitten werden.
 */
function buildColumns(headerCells: string[], dataRows: Grid): Column[] {
  let width = headerCells.length;
  for (const row of dataRows) {
    if (row.length > width) {
      width = row.length;
    }
  }

  const columns: Column[] = [];
  const used = new Set<string>();

  for (let index = 0; index < width; index += 1) {
    const name = normalizeHeaderCell(headerCells[index] ?? '');

    if (name === '') {
      const hasValues = dataRows.some((row) => (row[index] ?? '').trim() !== '');
      if (!hasValues) {
        continue;
      }
      columns.push({ index, name: uniqueName(`Spalte ${index + 1}`, used) });
      continue;
    }

    columns.push({ index, name: uniqueName(name, used) });
  }

  return columns;
}

function uniqueName(name: string, used: Set<string>): string {
  let candidate = name;
  let counter = 2;
  while (used.has(candidate)) {
    candidate = `${name} (${counter})`;
    counter += 1;
  }
  used.add(candidate);
  return candidate;
}
