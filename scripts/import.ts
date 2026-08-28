/**
 * CLI um den Import:
 *   npm run import -- <pfad> [--source=linkedin] [--sheet=<name|nr>] [--dry-run] [--yes]
 *
 * Dieses Skript enthaelt bewusst keine Importlogik. Es liest Argumente, parst
 * die Datei, holt bei einer unbekannten Spaltenaufteilung die Bestaetigung des
 * Menschen ein und gibt hinterher die Bilanz aus. Der Import selbst steckt in
 * lib/import/run.ts, damit der Upload im Interface (Meilenstein 3) denselben
 * Weg nimmt und nicht eine zweite, leicht abweichende Variante bekommt.
 *
 * Beispiele:
 *   npm run import -- ~/Downloads/Connections.csv --source=linkedin
 *   npm run import -- kontakte.xlsx --sheet=Kontakte --dry-run
 *   MUTUALS_DB_PATH=/tmp/test.db npm run import -- kontakte.csv --yes
 */

import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

import { z } from 'zod';

import type { Source } from '../lib/constants';
import { SOURCES } from '../lib/constants';
import { DB_PATH, closeDb } from '../lib/db';
import { applyMapping, suggestMapping } from '../lib/import/mapping';
import { parseFile } from '../lib/import/parse';
import { importParsedFile } from '../lib/import/run';
import type {
  ColumnMapping,
  ContactField,
  ImportRowResult,
  ImportSummary,
  MappingSuggestion,
  MappingTarget,
  ParsedFile,
} from '../lib/import/types';

/** Wie viele Datenzeilen die Vorschau zeigt. */
const PREVIEW_ROWS = 5;

/** Wie viele Fehlerzeilen einzeln ausgegeben werden, bevor gezaehlt wird. */
const MAX_LISTED_ERRORS = 20;

/** Dasselbe fuer die pruefwuerdigen Zeilen (Zuordnung nur ueber den Namen). */
const MAX_LISTED_ROWS = 20;

/** Laengste Spaltenbreite in der Vorschau, damit die Tabelle lesbar bleibt. */
const PREVIEW_CELL_WIDTH = 28;

const USAGE = [
  'Aufruf: npm run import -- <pfad> [--source=linkedin] [--sheet=<name|nr>] [--dry-run] [--yes]',
  '',
  '  <pfad>            CSV-, XLSX- oder XLS-Datei mit Kontakten.',
  '  --source=<quelle> Quelle der Kontakte: linkedin, csv oder manual.',
  '                    Ohne Angabe: linkedin, wenn ein LinkedIn-Export erkannt',
  '                    wurde, sonst csv.',
  '  --sheet=<name|nr> Arbeitsblatt einer Excel-Mappe: exakter Name oder',
  '                    1-basierte Nummer. Ohne Angabe wird das erste Blatt mit',
  '                    einer erkennbaren Kopfzeile gelesen.',
  '  --dry-run         Alles durchrechnen, nichts schreiben.',
  '  --yes             Die vorgeschlagene Spaltenzuordnung ohne Rueckfrage',
  '                    uebernehmen.',
  '',
  'Rueckgabewert: 0 wenn der Lauf etwas importiert oder als bereits vorhanden',
  'erkannt hat, sonst 1.',
].join('\n');

/** Fehler in der Aufrufzeile - fuehrt zur Kurzhilfe und Exit-Code 1. */
class UsageError extends Error {}

// ---------------------------------------------------------------------------
// Argumente
// ---------------------------------------------------------------------------

interface CliArgs {
  filePath: string;
  source?: Source;
  sheet?: string;
  dryRun: boolean;
  yes: boolean;
  help: boolean;
}

const sourceSchema = z.enum(SOURCES);

/** Wert einer Option in beiden Schreibweisen: --name=wert und --name wert. */
function optionValue(
  argv: readonly string[],
  index: number,
  arg: string,
  name: string,
): { value: string; consumed: number } {
  const prefix = `${name}=`;
  if (arg.startsWith(prefix)) {
    return { value: arg.slice(prefix.length), consumed: 0 };
  }
  return { value: argv[index + 1] ?? '', consumed: 1 };
}

function parseArgs(argv: readonly string[]): CliArgs {
  let filePath: string | null = null;
  let source: Source | undefined;
  let sheet: string | undefined;
  let dryRun = false;
  let yes = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';

    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (arg === '--yes') {
      yes = true;
      continue;
    }

    if (arg === '--source' || arg.startsWith('--source=')) {
      const option = optionValue(argv, index, arg, '--source');
      index += option.consumed;
      const parsed = sourceSchema.safeParse(option.value);
      if (!parsed.success) {
        throw new UsageError(
          `Unbekannte Quelle "${option.value}". Erlaubt sind: ${SOURCES.join(', ')}.`,
        );
      }
      source = parsed.data;
      continue;
    }

    if (arg === '--sheet' || arg.startsWith('--sheet=')) {
      const option = optionValue(argv, index, arg, '--sheet');
      index += option.consumed;
      if (option.value.trim() === '') {
        throw new UsageError('--sheet braucht einen Blattnamen oder eine Blattnummer.');
      }
      sheet = option.value;
      continue;
    }

    if (arg.startsWith('-')) {
      throw new UsageError(`Unbekannte Option "${arg}".`);
    }

    if (filePath !== null) {
      throw new UsageError(
        `Es kann nur eine Datei auf einmal importiert werden ("${filePath}" und "${arg}").`,
      );
    }
    filePath = arg;
  }

  if (help) {
    return { filePath: '', dryRun, yes, help: true };
  }
  if (filePath === null || filePath.trim() === '') {
    throw new UsageError('Es wurde keine Datei angegeben.');
  }

  const args: CliArgs = { filePath, dryRun, yes, help: false };
  if (source !== undefined) {
    args.source = source;
  }
  if (sheet !== undefined) {
    args.sheet = sheet;
  }
  return args;
}

/**
 * Prueft die Datei, bevor der Parser sie anfasst - so unterscheidet die Meldung
 * "gibt es nicht" von "ist ein Verzeichnis" von "darf ich nicht lesen", statt
 * alles als einen Parserfehler auszugeben.
 */
function requireReadableFile(filePath: string): string {
  const absolute = path.resolve(filePath);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolute);
  } catch {
    throw new UsageError(`Die Datei "${absolute}" gibt es nicht.`);
  }

  if (stat.isDirectory()) {
    throw new UsageError(`"${absolute}" ist ein Verzeichnis, keine Datei.`);
  }

  try {
    fs.accessSync(absolute, fs.constants.R_OK);
  } catch {
    throw new UsageError(`Die Datei "${absolute}" ist nicht lesbar.`);
  }

  return absolute;
}

// ---------------------------------------------------------------------------
// Ausgabe
// ---------------------------------------------------------------------------

const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  email: 'E-Mail',
  linkedin_url: 'LinkedIn-URL',
  company: 'Firma',
  title: 'Titel / Position',
  city: 'Stadt',
  country: 'Land',
  phone: 'Telefon',
  birthday: 'Geburtstag',
  how_we_met: 'Kennengelernt',
  created_at: 'Kontakt seit (created_at)',
};

function describeTarget(target: MappingTarget): string {
  switch (target.kind) {
    case 'field':
      return FIELD_LABELS[target.field] ?? target.field;
    case 'name_part':
      return target.part === 'first' ? 'Vorname (Teil von Name)' : 'Nachname (Teil von Name)';
    case 'ignore':
      return 'wird nicht importiert';
  }
}

/** Richtet eine Tabelle an den laengsten Zellen aus. */
function renderTable(rows: ReadonlyArray<readonly string[]>): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, column) => {
      widths[column] = Math.max(widths[column] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    row
      .map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0)))
      .join('  ')
      .trimEnd(),
  );
}

/** Einzeilige, gekuerzte Darstellung eines Werts fuer die Vorschau. */
function previewCell(value: string | null | undefined): string {
  if (value === null || value === undefined) {
    return '-';
  }
  const single = value.replace(/\s+/gu, ' ').trim();
  if (single === '') {
    return '-';
  }
  return single.length > PREVIEW_CELL_WIDTH ? `${single.slice(0, PREVIEW_CELL_WIDTH - 1)}…` : single;
}

function printMapping(suggestion: MappingSuggestion): void {
  console.log('Vorgeschlagene Spaltenzuordnung:');
  const table = renderTable([
    ['  Spalte', 'Ziel'],
    ['  ------', '----'],
    ...Object.entries(suggestion.mapping).map(([header, target]) => [
      `  ${header}`,
      describeTarget(target),
    ]),
  ]);
  for (const line of table) {
    console.log(line);
  }

  if (suggestion.unmapped.length > 0) {
    console.log('');
    console.log(
      `Ohne Ziel und damit nicht importiert: ${suggestion.unmapped
        .map((header) => `"${header}"`)
        .join(', ')}.`,
    );
  }
}

/**
 * Vorschau der ersten Datenzeilen - und zwar so, wie sie nach der Zuordnung
 * aussehen, nicht als Rohzellen. Der Nutzer soll ja beurteilen, was in der
 * Datenbank landet.
 */
function printPreview(parsed: ParsedFile, mapping: ColumnMapping): void {
  const rows = parsed.rows.slice(0, PREVIEW_ROWS);
  if (rows.length === 0) {
    return;
  }

  const fields = ['name', 'email', 'linkedin_url', 'company', 'title'] as const;
  const header = ['  #', ...fields.map((field) => FIELD_LABELS[field] ?? field)];

  const body = rows.map((row, position) => {
    const contact = applyMapping(row, mapping);
    return [`  ${position + 1}`, ...fields.map((field) => previewCell(contact[field]))];
  });

  console.log('');
  console.log(`Vorschau der ersten ${rows.length} Datenzeile(n):`);
  for (const line of renderTable([header, header.map((cell) => '-'.repeat(cell.length)), ...body])) {
    console.log(line);
  }
}

const MATCH_LABELS: Record<NonNullable<ImportRowResult['matchedBy']>, string> = {
  linkedin_url: 'über die Profil-URL',
  email: 'über die E-Mail-Adresse',
  name: 'nur über den Namen',
};

function printSummary(summary: ImportSummary, dryRun: boolean): void {
  console.log('');
  console.log(
    `Zusammenfassung: ${summary.created} neu, ${summary.enriched} ergänzt, ` +
      `${summary.skipped} übersprungen` +
      // Die Fehlerzahl gehoert in die Kopfzeile, sobald es welche gibt. Sonst
      // gehen die Zahlen nicht auf ("1 neu, 0 ergänzt, 0 übersprungen (von 2
      // Datenzeilen)") und der Leser sucht den Rest.
      (summary.errors > 0 ? `, ${summary.errors} fehlerhaft` : '') +
      ` (von ${summary.total} Datenzeilen).`,
  );

  for (const [matchedBy, count] of groupMatches(summary, 'enriched')) {
    console.log(`  ergänzt: ${count} x ${MATCH_LABELS[matchedBy]} zugeordnet`);
  }

  for (const [reason, count] of groupReasons(summary, 'skipped')) {
    console.log(`  übersprungen: ${count} x ${reason}`);
  }

  printNameMatches(summary);
  printDropped(summary);

  if (summary.errors > 0) {
    console.log('');
    console.log(`${summary.errors} Zeile(n) mit Fehler:`);
    const failed = summary.rows.filter((row) => row.outcome === 'error');
    for (const row of failed.slice(0, MAX_LISTED_ERRORS)) {
      console.log(`  Datenzeile ${row.rowNumber}: ${row.reason ?? 'unbekannter Fehler'}`);
    }
    if (failed.length > MAX_LISTED_ERRORS) {
      console.log(`  ... und ${failed.length - MAX_LISTED_ERRORS} weitere.`);
    }
  }

  if (dryRun) {
    console.log('');
    console.log('Trockenlauf: es wurde nichts in die Datenbank geschrieben.');
  }
}

/**
 * Zeilen, die nur ueber den Namen zugeordnet wurden, einzeln auflisten.
 *
 * Das ist die schwaechste Stufe der Dublettenpruefung, und sie ist die einzige,
 * die zwei verschiedene Menschen treffen kann - 'Anna Schmidt' gibt es zweimal.
 * Die Identitaetsfelder schreibt der Import dort nicht (siehe run.ts), aber
 * Firma, Titel oder Stadt schon. Deshalb bekommt der Mensch hier Zeilennummer
 * und Kontakt-ID, um genau diese Faelle nachsehen zu koennen.
 */
function printNameMatches(summary: ImportSummary): void {
  const byName = summary.rows.filter(
    (row) => row.matchedBy === 'name' && row.outcome === 'enriched',
  );
  if (byName.length === 0) {
    return;
  }

  console.log('');
  console.log(
    `${byName.length} Zeile(n) wurden nur über den Namen zugeordnet - bitte prüfen, ` +
      'ob es wirklich dieselbe Person ist:',
  );
  for (const row of byName.slice(0, MAX_LISTED_ROWS)) {
    console.log(`  Datenzeile ${row.rowNumber} -> Kontakt ${row.contactId ?? '?'}`);
  }
  if (byName.length > MAX_LISTED_ROWS) {
    console.log(`  ... und ${byName.length - MAX_LISTED_ROWS} weitere.`);
  }
}

/**
 * Werte, die in der Datei standen und trotzdem nicht im Kontakt gelandet sind.
 *
 * Ohne diesen Block ist eine Zeile mit unlesbarem Datum von einer mit leerer
 * Datumsspalte nicht zu unterscheiden - der Kontakt traegt dann den
 * Importzeitpunkt als Anlagedatum und niemand merkt es. Das Beispiel aus der
 * Datei steht mit dabei, damit der Nutzer sieht, welches Format gemeint war.
 */
interface DroppedGroup {
  count: number;
  example: string;
  field: ContactField;
  reason: string;
}

function printDropped(summary: ImportSummary): void {
  const counts = new Map<string, DroppedGroup>();
  for (const row of summary.rows) {
    for (const dropped of row.dropped ?? []) {
      // Schluessel aus Feld UND Grund: dieselbe Spalte kann aus zwei
      // verschiedenen Gruenden durchfallen, und beide sollen getrennt
      // gezaehlt werden.
      const key = `${dropped.field}/${dropped.reason}`;
      const known = counts.get(key);
      if (known === undefined) {
        counts.set(key, {
          count: 1,
          example: dropped.value,
          field: dropped.field,
          reason: dropped.reason,
        });
      } else {
        known.count += 1;
      }
    }
  }
  if (counts.size === 0) {
    return;
  }

  console.log('');
  for (const entry of counts.values()) {
    const label = FIELD_LABELS[entry.field] ?? entry.field;
    console.log(
      `${entry.count} Zeile(n) mit unbrauchbarem Wert in "${label}" (${entry.reason}), ` +
        `z.B. "${previewCell(entry.example)}" - der Wert wurde nicht übernommen.`,
    );
  }

  // Nur beim Datum hat das eine Folge, die man nicht sieht: der Kontakt
  // traegt dann den Importzeitpunkt. Eine verworfene E-Mail hinterlaesst
  // schlicht ein leeres Feld.
  if ([...counts.values()].some((entry) => entry.field === 'created_at')) {
    console.log(
      'Bei unlesbarem Datum trägt der Kontakt den Importzeitpunkt als Anlagedatum. ' +
        'Wer das Format kennt, kann die Spalte in der Datei umstellen und erneut einlesen.',
    );
  }
}

/** Zaehlt die Begruendungen eines Ausgangs zusammen, in erster Reihenfolge. */
function groupReasons(
  summary: ImportSummary,
  outcome: ImportRowResult['outcome'],
): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const row of summary.rows) {
    if (row.outcome !== outcome) {
      continue;
    }
    const reason = row.reason ?? 'ohne Begründung';
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts.entries()];
}

/** Dasselbe fuer die Stufe, ueber die eine Zeile zugeordnet wurde. */
function groupMatches(
  summary: ImportSummary,
  outcome: ImportRowResult['outcome'],
): Array<[NonNullable<ImportRowResult['matchedBy']>, number]> {
  const counts = new Map<NonNullable<ImportRowResult['matchedBy']>, number>();
  for (const row of summary.rows) {
    if (row.outcome !== outcome || row.matchedBy === undefined) {
      continue;
    }
    counts.set(row.matchedBy, (counts.get(row.matchedBy) ?? 0) + 1);
  }
  return [...counts.entries()];
}

// ---------------------------------------------------------------------------
// Rueckfrage
// ---------------------------------------------------------------------------

/**
 * Fragt nach, ob die Zuordnung stimmt.
 *
 * Ohne Terminal (Cron, CI, Pipe) wird NICHT blockierend gewartet - ein
 * haengendes Skript ohne sichtbare Frage ist das schlechteste aller Ergebnisse.
 * Stattdessen der Hinweis auf --yes und ein sauberer Abbruch.
 */
async function confirmMapping(): Promise<boolean> {
  if (process.stdin.isTTY !== true) {
    console.log('');
    console.log(
      'Die Spaltenzuordnung ist nicht eindeutig und die Eingabe ist kein Terminal, ' +
        'es kann also nicht nachgefragt werden.',
    );
    console.log('Abbruch. Mit --yes wird die Zuordnung oben ohne Rückfrage übernommen.');
    return false;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('\nZuordnung übernehmen und importieren? [j/N] ');
    return /^(j|ja|y|yes)$/iu.test(answer.trim());
  } catch {
    // Strg+C oder Strg+D waehrend der Frage: die Eingabe endet, ohne dass eine
    // Antwort kam. Das ist ein Nein und kein Fehler des Skripts.
    console.log('');
    console.log('Eingabe abgebrochen.');
    return false;
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Ablauf
// ---------------------------------------------------------------------------

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }

  const absolute = requireReadableFile(args.filePath);
  const parsed = args.sheet === undefined
    ? parseFile(absolute)
    : parseFile(absolute, { sheet: args.sheet });
  const suggestion = suggestMapping(parsed.headers);

  console.log(`Datei:     ${absolute}`);
  console.log(
    `Format:    ${parsed.format}` +
      (parsed.sheetName === undefined ? '' : `, Arbeitsblatt "${parsed.sheetName}"`) +
      (parsed.preambleLines > 0 ? `, ${parsed.preambleLines} Zeile(n) Präambel übersprungen` : ''),
  );
  console.log(`Inhalt:    ${parsed.rows.length} Datenzeile(n), ${parsed.headers.length} Spalte(n)`);
  console.log(
    `Erkannt:   ${suggestion.detectedSource === 'linkedin' ? 'LinkedIn-Export' : 'unbekanntes Format'}`,
  );
  console.log(`Datenbank: ${DB_PATH}`);

  // Die Hinweise des Parsers kommen VOR Vorschau und Rueckfrage: eine Datei,
  // die als Windows-1252 gelesen werden musste, will man an der Vorschau
  // pruefen, bevor die Umlaute in der Datenbank stehen.
  for (const warning of parsed.warnings ?? []) {
    console.log('');
    console.log(`Hinweis:   ${warning}`);
  }
  console.log('');

  if (parsed.rows.length === 0) {
    console.log('Die Datei enthält keine Datenzeilen. Es gibt nichts zu importieren.');
    return 0;
  }

  if (!suggestion.confident && !args.yes) {
    printMapping(suggestion);
    printPreview(parsed, suggestion.mapping);
    if (!(await confirmMapping())) {
      console.log('Abgebrochen. Es wurde nichts geschrieben.');
      return 1;
    }
  }

  const source = args.source ?? (suggestion.detectedSource === 'linkedin' ? 'linkedin' : 'csv');
  const summary = importParsedFile(parsed, {
    source,
    mapping: suggestion.mapping,
    dryRun: args.dryRun,
  });

  printSummary(summary, args.dryRun);
  return exitCode(summary);
}

/**
 * Rueckgabewert des Laufs.
 *
 * Fehlerzeilen sind das eine. Wichtiger ist der Lauf, der GAR NICHTS erreicht
 * hat: 'npm run import -- artikelliste.csv --yes' meldete bisher
 * "0 neu, 0 ergänzt, 3 übersprungen" und Rueckgabewert 0 - ein Skript im
 * Cron- oder CI-Betrieb (fuer den --yes ja gedacht ist) konnte Erfolg und
 * Totalausfall nicht unterscheiden.
 *
 * Der wiederholte Lauf derselben Datei darf davon NICHT betroffen sein: dort
 * ist "alles uebersprungen" genau das erwartete Ergebnis. Der Unterschied
 * steckt im Grund - eine Zeile, die auf einen bestehenden Kontakt gezeigt hat
 * (contactId gesetzt), war erfolgreich, auch wenn es nichts zu tun gab. Eine
 * Zeile ohne Namen oder ohne Zuordnung war es nicht.
 */
function exitCode(summary: ImportSummary): number {
  if (summary.errors > 0) {
    return 1;
  }
  if (summary.total === 0) {
    return 0;
  }
  const recognized = summary.rows.filter(
    (row) => row.outcome === 'created' || row.outcome === 'enriched' || row.contactId !== undefined,
  ).length;
  return recognized === 0 ? 1 : 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`Fehler: ${error.message}`);
    console.error('');
    console.error(USAGE);
  } else {
    console.error(`Fehler: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 1;
} finally {
  closeDb();
}
