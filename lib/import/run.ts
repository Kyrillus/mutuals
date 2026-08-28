/**
 * Schritt 3 des Imports: aus einem ParsedFile werden Kontakte.
 *
 * importParsedFile ist die einzige Stelle, an der der Import schreibt, und sie
 * ist bewusst kein CLI-Skript: scripts/import.ts ruft sie auf, der Upload im
 * Interface (Meilenstein 3) ruft dieselbe Funktion mit demselben ParsedFile aus
 * parseBuffer auf. Was der Nutzer im Browser hochlaedt, nimmt damit exakt den
 * Weg, der hier getestet ist.
 *
 * Eigenes SQL gibt es hier nicht - geschrieben wird ausschliesslich ueber
 * insertImportedContact und enrichContact aus lib/queries.ts.
 */

import { z } from 'zod';

import type { Source } from '../constants';
import { SOURCES } from '../constants';
import { withTransaction } from '../db';
import {
  enrichContact,
  getAllContactsForDedup,
  getContact,
  insertImportedContact,
} from '../queries';
import type { Contact, ContactPatch } from '../types';

import type { DedupeIndex, DedupeMatch } from './dedupe';
import { buildDedupeIndex } from './dedupe';
import { columnMappingSchema, mapRow, suggestMapping } from './mapping';
import type {
  ColumnMapping,
  DroppedValue,
  ImportRowResult,
  ImportSummary,
  NewContactInput,
  ParsedFile,
  RawRow,
} from './types';

export interface ImportOptions {
  source?: 'linkedin' | 'csv' | 'manual';
  /** wenn gesetzt, wird suggestMapping uebersprungen */
  mapping?: ColumnMapping;
  dryRun?: boolean;
}

/** Grund, mit dem eine Zeile ohne Namen liegen bleibt. */
const REASON_NO_NAME = 'kein verwertbarer Name in der Zeile';

/** Grund, mit dem eine Dublette ohne neue Information liegen bleibt. */
const REASON_NOTHING_TO_ENRICH = 'nichts zu ergänzen';

/**
 * Grund fuer eine Zeile, die nur ueber den Namen zugeordnet wurde und deren
 * einzige Neuigkeit ein Identitaetsfeld war - siehe IDENTITY_FIELDS.
 */
const REASON_NAME_ONLY =
  'nur über den Namen zugeordnet, E-Mail und Profil-URL wurden nicht übernommen';

/**
 * Die Felder, an denen die Dublettenpruefung selbst haengt.
 *
 * Sie duerfen bei einem Treffer der SCHWAECHSTEN Stufe (Name) nicht
 * geschrieben werden. Sonst verschmelzen zwei Menschen gleichen Namens
 * dauerhaft zu einem Datensatz - und der Fehler verstaerkt sich selbst: ab dem
 * naechsten Lauf greift Stufe 1 auf denselben Kontakt, und der Treffer ist von
 * einem echten nicht mehr zu unterscheiden. Im LinkedIn-Export hat die
 * Mehrheit der Zeilen keine E-Mail-Adresse, faellt also genau auf die
 * Namensstufe durch; 'Anna Schmidt' zweimal ist dort der Normalfall.
 *
 * Alles andere (Firma, Titel, Stadt, Telefon ...) wird weiterhin ergaenzt: ein
 * falsch zugeordneter Firmenname ist aergerlich, aber sichtbar und
 * korrigierbar. Eine fremde Profil-URL am eigenen Kontakt ist es nicht.
 */
const IDENTITY_FIELDS = ['email', 'linkedin_url'] as const satisfies readonly (keyof ContactPatch)[];

// ---------------------------------------------------------------------------
// Eingabevalidierung
// ---------------------------------------------------------------------------

/**
 * Das ParsedFile kommt heute aus parse.ts, in Meilenstein 3 aber aus einem
 * HTTP-Request. Geprueft wird deshalb die Struktur, nicht der Inhalt: dass die
 * Zeilen wirklich Objekte aus Zeichenketten sind. Alles Weitere (Laengen,
 * Formate) prueft die Query-Schicht pro Feld, und zwar dort, wo auch der
 * Fehlertext hingehoert.
 */
const parsedFileSchema = z.object({
  headers: z.array(z.string()),
  rows: z.array(z.record(z.string(), z.string())),
  preambleLines: z.number().int().min(0),
  format: z.enum(['csv', 'xlsx', 'xls']),
  sheetName: z.string().optional(),
  warnings: z.array(z.string()).optional(),
});

/**
 * Kopiert eine gepruefte Zeile in ein Objekt ohne Prototyp.
 *
 * Warum nicht einfach die Ausgabe von zod nehmen: z.record baut sein Ergebnis
 * als gewoehnliches Objektliteral und schreibt die Werte mit out[key] = value.
 * Fuer den Schluessel '__proto__' trifft das den Prototype-Setter, und der
 * ignoriert einen String stillschweigend - die Spalte ist danach weg. Genau
 * denselben Fehler vermeidet parse.ts beim Bauen der Zeilen; ohne diese Kopie
 * wuerde die Validierung ihn hier wieder einfuehren.
 *
 * Gelesen wird deshalb aus dem ORIGINAL, nicht aus der zod-Ausgabe. Das ist
 * sicher, weil zod jede eigene Property dieser Zeile bereits als String
 * bestaetigt hat; die Kopie prueft den Typ trotzdem noch einmal, damit hier
 * keine Annahme ueber zod-Interna steht.
 */
function toRawRow(source: RawRow): RawRow {
  const row: RawRow = Object.create(null) as RawRow;
  for (const key of Object.keys(source)) {
    const value: unknown = source[key];
    if (typeof value === 'string') {
      row[key] = value;
    }
  }
  return row;
}

/**
 * Dasselbe fuer eine von aussen gereichte Zuordnung: z.record verliert den
 * Schluessel '__proto__' genauso wie bei den Zeilen. Eine Datei mit einer so
 * benannten Spalte haette danach eine Zuordnung, die diese Spalte nicht kennt.
 */
function toColumnMapping(source: ColumnMapping): ColumnMapping {
  const mapping: ColumnMapping = Object.create(null) as ColumnMapping;
  for (const key of Object.keys(source)) {
    const target = source[key];
    if (target !== undefined) {
      mapping[key] = target;
    }
  }
  return mapping;
}

const importOptionsSchema = z.object({
  source: z.enum(SOURCES).optional(),
  mapping: columnMappingSchema.optional(),
  dryRun: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Trockenlauf
// ---------------------------------------------------------------------------

/**
 * Der Trockenlauf ist kein zweiter Codepfad, sondern derselbe Lauf mit einem
 * Rollback am Ende.
 *
 * Das ist der Kern: wuerde --dry-run die Schreibaufrufe ueberspringen, wuerde
 * er auch alles nicht sehen, was erst beim Schreiben auffaellt - ein zu langer
 * Name, ein Datum, das die Query-Schicht ablehnt, eine Zeile, die erst durch
 * die vorherige zur Dublette wird. Genau das soll ein Trockenlauf ja zeigen.
 * Deshalb laeuft alles wirklich durch und wird am Schluss verworfen; getragen
 * wird das Ergebnis von dieser Ausnahme nach draussen.
 */
class DryRunRollback extends Error {
  readonly summary: ImportSummary;

  constructor(summary: ImportSummary) {
    super('Trockenlauf: die Transaktion wird absichtlich zurueckgerollt.');
    this.name = 'DryRunRollback';
    this.summary = summary;
  }
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * Importiert eine geparste Datei. Rueckgabe ist die vollstaendige Bilanz mit
 * einer Zeile pro Datenzeile.
 *
 * Der gesamte Lauf steckt in EINER Transaktion. Bricht etwas hart ab (die
 * Datenbank ist gesperrt, die Platte ist voll), ist hinterher nichts
 * importiert statt die Haelfte - bei 900 Kontakten ist ein halber Import
 * schlimmer als gar keiner, weil niemand weiss, wo er stand.
 *
 * Davon zu unterscheiden sind Fehler EINER Zeile (ein 300 Zeichen langer Name,
 * eine unmoegliche E-Mail-Laenge): die werden als outcome 'error' mit
 * Begruendung protokolliert, der Rest der Datei laeuft weiter. Sonst
 * verhinderte eine einzige kaputte Zeile den Import der 899 guten, ohne dass
 * man wuesste, welche es war.
 */
export function importParsedFile(parsed: ParsedFile, opts: ImportOptions = {}): ImportSummary {
  const file = parsedFileSchema.parse(parsed);
  const options = importOptionsSchema.parse(opts);

  // Gelesen wird aus dem ORIGINAL, geprueft ist es ueber die Schemas oben -
  // siehe die Begruendung an toRawRow.
  const { mapping, source } = resolveMapping(file.headers, {
    ...options,
    ...(opts.mapping === undefined ? {} : { mapping: toColumnMapping(opts.mapping) }),
  });
  const rows = parsed.rows.map(toRawRow);

  try {
    return withTransaction(() => {
      const summary = importRows(rows, mapping, source);
      if (options.dryRun === true) {
        throw new DryRunRollback(summary);
      }
      return summary;
    });
  } catch (error) {
    if (error instanceof DryRunRollback) {
      return error.summary;
    }
    throw error;
  }
}

/**
 * Zuordnung und Quelle bestimmen.
 *
 * Eine mitgegebene Zuordnung ueberspringt suggestMapping - so steht es im
 * Kontrakt, und der Aufrufer hat sie ja gerade deshalb mitgegeben, weil er sie
 * (per Rueckfrage oder Formular) bereits geklaert hat. Die Quelle faellt dann
 * auf 'csv' zurueck; wer LinkedIn meint, sagt es ueber opts.source, so wie die
 * CLI es mit --source=linkedin tut.
 */
function resolveMapping(
  headers: readonly string[],
  options: { source?: Source; mapping?: ColumnMapping },
): { mapping: ColumnMapping; source: Source } {
  if (options.mapping !== undefined) {
    return { mapping: options.mapping, source: options.source ?? 'csv' };
  }

  const suggestion = suggestMapping([...headers]);
  return {
    mapping: suggestion.mapping,
    source: options.source ?? (suggestion.detectedSource === 'linkedin' ? 'linkedin' : 'csv'),
  };
}

/**
 * Der eigentliche Durchlauf. Der Dublettenindex wird EINMAL aus dem
 * Datenbankstand gebaut und waechst danach mit jedem angelegten oder
 * ergaenzten Kontakt mit - ohne das waeren zwei Dubletten innerhalb derselben
 * Datei zwei neue Kontakte, und der zweite Lauf faende zwei Kandidaten vor.
 */
function importRows(
  rows: readonly RawRow[],
  mapping: ColumnMapping,
  source: Source,
): ImportSummary {
  const index = buildDedupeIndex(getAllContactsForDedup());
  const results: ImportRowResult[] = rows.map((row, position) =>
    importRow(row, position + 1, mapping, source, index),
  );

  return {
    total: results.length,
    created: countOutcome(results, 'created'),
    enriched: countOutcome(results, 'enriched'),
    skipped: countOutcome(results, 'skipped'),
    errors: countOutcome(results, 'error'),
    rows: results,
  };
}

function countOutcome(
  results: readonly ImportRowResult[],
  outcome: ImportRowResult['outcome'],
): number {
  return results.filter((result) => result.outcome === outcome).length;
}

/**
 * Eine einzelne Zeile.
 *
 * Reihenfolge: erst deuten, dann die Pflichtpruefung, dann die
 * Dublettenpruefung, dann schreiben. Eine Zeile ohne verwertbaren Namen ist
 * 'skipped' und nicht 'error' - eine Leerzeile am Dateiende oder ein
 * Kontakt, von dem LinkedIn nur die Firma kennt, ist kein Fehler des Nutzers,
 * sondern eine Zeile, zu der es nichts zu importieren gibt.
 */
function importRow(
  row: RawRow,
  rowNumber: number,
  mapping: ColumnMapping,
  source: Source,
  index: DedupeIndex,
): ImportRowResult {
  let candidate: Partial<NewContactInput>;
  let dropped: DroppedValue[];
  try {
    const mapped = mapRow(row, mapping);
    candidate = mapped.contact;
    dropped = mapped.dropped;
  } catch (error) {
    return { rowNumber, outcome: 'error', reason: describeError(error) };
  }

  const name = candidate.name;
  if (typeof name !== 'string' || name === '') {
    return withDropped({ rowNumber, outcome: 'skipped', reason: REASON_NO_NAME }, dropped);
  }

  const match = index.find(candidate);

  try {
    if (match === null) {
      const created = insertImportedContact({ ...candidate, name, source });
      index.add(toDedupeEntry(created));
      return withDropped({ rowNumber, outcome: 'created', contactId: created.id }, dropped);
    }

    const before = getContact(match.id);
    if (before === null) {
      return {
        rowNumber,
        outcome: 'error',
        reason: `Kontakt ${match.id} aus der Dublettenpruefung ist nicht mehr vorhanden`,
      };
    }

    const patch = toContactPatch(candidate, match);
    const after = enrichContact(match.id, patch);
    if (!wasEnriched(before, after)) {
      return withDropped(
        {
          rowNumber,
          outcome: 'skipped',
          contactId: after.id,
          matchedBy: match.matchedBy,
          // Zwei verschiedene Gruende, die man nicht verwechseln darf: "die
          // Zeile wiederholt nur, was schon dasteht" gegen "die Zeile brachte
          // etwas mit, wir haben es nur nicht angefasst".
          reason: withheldIdentity(candidate, match) ? REASON_NAME_ONLY : REASON_NOTHING_TO_ENRICH,
        },
        dropped,
      );
    }

    // Erst jetzt in den Index: die frisch gefuellte E-Mail-Adresse oder
    // Profil-URL ist ab der naechsten Zeile ein gueltiger Dublettenschluessel.
    index.add(toDedupeEntry(after));
    return withDropped(
      { rowNumber, outcome: 'enriched', contactId: after.id, matchedBy: match.matchedBy },
      dropped,
    );
  } catch (error) {
    return { rowNumber, outcome: 'error', reason: describeError(error) };
  }
}

/** Haengt die verworfenen Werte an, ohne bei der leeren Liste ein Feld zu setzen. */
function withDropped(result: ImportRowResult, dropped: readonly DroppedValue[]): ImportRowResult {
  return dropped.length === 0 ? result : { ...result, dropped: [...dropped] };
}

/**
 * Hatte die Zeile ein Identitaetsfeld dabei, das wegen der schwachen
 * Zuordnungsstufe nicht geschrieben wurde? Nur dann ist die Zeile
 * pruefwuerdig.
 */
function withheldIdentity(candidate: Partial<NewContactInput>, match: DedupeMatch): boolean {
  if (match.matchedBy !== 'name') {
    return false;
  }
  return IDENTITY_FIELDS.some((field) => {
    const value = candidate[field];
    return typeof value === 'string' && value !== '';
  });
}

function toDedupeEntry(contact: Contact): {
  id: number;
  name: string;
  email: string | null;
  linkedin_url: string | null;
} {
  return {
    id: contact.id,
    name: contact.name,
    email: contact.email,
    linkedin_url: contact.linkedin_url,
  };
}

/**
 * Aus dem Teil-Kontakt wird ein Patch.
 *
 * created_at faellt immer weg: ein bestehender Kontakt behaelt sein
 * Anlagedatum, auch wenn eine spaetere Datei ein anderes 'Connected On'
 * mitbringt. ContactPatch kennt das Feld deshalb gar nicht erst.
 *
 * Bei einem Treffer der Namensstufe fallen zusaetzlich die Identitaetsfelder
 * weg - Begruendung an IDENTITY_FIELDS.
 */
function toContactPatch(candidate: Partial<NewContactInput>, match: DedupeMatch): ContactPatch {
  const { created_at: _createdAt, ...patch } = candidate;
  if (match.matchedBy !== 'name') {
    return patch;
  }
  for (const field of IDENTITY_FIELDS) {
    delete patch[field];
  }
  return patch;
}

/**
 * Spalten, die enrichContact fuellen kann (status und created_at gehoeren
 * ausdruecklich nicht dazu). Der Vergleich vorher/nachher beantwortet die
 * Frage "wurde wirklich etwas ergaenzt?", ohne die Regel "nur leere Felder"
 * hier ein zweites Mal zu formulieren - eine zweite Formulierung koennte von
 * der in lib/queries.ts abweichen, und dann zaehlte die Bilanz etwas anderes,
 * als in der Datenbank steht.
 */
const ENRICHABLE_COLUMNS = [
  'name',
  'stage',
  'role',
  'company',
  'title',
  'city',
  'country',
  'email',
  'phone',
  'linkedin_url',
  'birthday',
  'how_we_met',
  'closeness',
  'source',
  'last_contact_at',
] as const satisfies readonly (keyof Contact)[];

function wasEnriched(before: Contact, after: Contact): boolean {
  return ENRICHABLE_COLUMNS.some((column) => before[column] !== after[column]);
}

/**
 * Fehlertext fuer die Protokollzeile. Bei einem ZodError ist die Meldung von
 * Haus aus ein JSON-Block ueber mehrere Zeilen - hier wird daraus
 * "feld: grund", damit die Zusammenfassung lesbar bleibt.
 */
function describeError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => {
        const path = issue.path.join('.');
        return path === '' ? issue.message : `${path}: ${issue.message}`;
      })
      .join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}
