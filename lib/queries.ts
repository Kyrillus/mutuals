/**
 * Zentrale Datenzugriffsschicht von Mutuals.
 *
 * Hier und nur hier steht SQL (Ausnahme: scripts/migrate.ts). App und
 * MCP-Server benutzen ausschliesslich die Funktionen aus dieser Datei.
 *
 * Regeln, die in diesem File durchgehalten werden:
 *   - Jede Schreiboperation laeuft in einer Transaktion (withTransaction).
 *   - Alle Werte gehen als Parameter in vorbereitete Statements. In SQL-Strings
 *     interpoliert werden ausschliesslich Dinge, die aus diesem File selbst
 *     stammen: feste Spaltenlisten, generierte Platzhalterketten ("?, ?, ?")
 *     und ORDER-BY-Fragmente aus einer Whitelist. Niemals Nutzereingaben.
 *   - Alle Eingaben werden mit zod validiert, bevor sie die Datenbank sehen.
 */

import type Database from 'better-sqlite3';
import { z } from 'zod';

import {
  CLOSENESS_MAX,
  CLOSENESS_MIN,
  CONTACT_STATUSES,
  ROLES,
  SOURCES,
  STAGES,
  type ContactStatus,
  type Stage,
} from './constants';
import { getDb, nowIso, todayIso, withTransaction } from './db';
import { normalizeText, stripControlCharacters, stripSearchNoise } from './text';
import type {
  Connection,
  Contact,
  ContactDetail,
  ContactFilters,
  ContactPatch,
  ContactListRow,
  MatchCandidate,
  MatchEvidence,
  Need,
  NewContactInput,
  Note,
  Offer,
  Tag,
} from './types';

// ---------------------------------------------------------------------------
// Fehler
// ---------------------------------------------------------------------------

/**
 * Wird geworfen, wenn eine Operation eine Zeile veraendern soll, die es nicht
 * (mehr) gibt. Die aufrufende Schicht kann das auf 404 abbilden.
 */
export class NotFoundError extends Error {
  readonly entity: string;
  readonly id: number;

  constructor(entity: string, id: number) {
    super(`${entity} mit der ID ${id} existiert nicht.`);
    this.name = 'NotFoundError';
    this.entity = entity;
    this.id = id;
  }
}

// ---------------------------------------------------------------------------
// Statement-Helfer
// ---------------------------------------------------------------------------

/**
 * Vorbereitete Statements werden pro Datenbankverbindung gecacht. Der Cache
 * haengt am Database-Objekt (WeakMap), damit ein closeDb() gefolgt von einem
 * neuen getDb() nicht auf Statements der alten, geschlossenen Verbindung
 * zurueckgreift.
 */
const statementCache = new WeakMap<Database.Database, Map<string, Database.Statement<unknown[]>>>();

/**
 * Liefert das vorbereitete Statement zu diesem SQL. Der Cast auf den
 * Ergebnistyp ist die einzige Stelle mit einer Typzusicherung: ein Cache ueber
 * verschiedene Zeilentypen laesst sich nicht generisch typisieren. Er ist
 * gleichwertig zu dem, was db.prepare<…, R>() ohnehin tut - eine Zusage des
 * Autors ueber die Spalten des SELECT.
 */
function stmt<R>(sql: string): Database.Statement<unknown[], R> {
  const db = getDb();
  let perDb = statementCache.get(db);
  if (perDb === undefined) {
    perDb = new Map<string, Database.Statement<unknown[]>>();
    statementCache.set(db, perDb);
  }
  const cached = perDb.get(sql);
  if (cached !== undefined) {
    return cached as Database.Statement<unknown[], R>;
  }
  const prepared = db.prepare<unknown[], R>(sql);
  perDb.set(sql, prepared as Database.Statement<unknown[]>);
  return prepared;
}

function allRows<R>(sql: string, params: readonly unknown[] = []): R[] {
  return stmt<R>(sql).all(...params);
}

function oneRow<R>(sql: string, params: readonly unknown[] = []): R | null {
  return stmt<R>(sql).get(...params) ?? null;
}

function runSql(sql: string, params: readonly unknown[] = []): Database.RunResult {
  return stmt<unknown>(sql).run(...params);
}

/** Platzhalterkette "?, ?, ?" fuer IN-Listen. Die Laenge stammt nie vom Nutzer. */
function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}

function chunk<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) {
    out.push(values.slice(i, i + size));
  }
  return out;
}

/**
 * SQLite erlaubt eine begrenzte Zahl gebundener Parameter (Standard 32766).
 * IN-Listen ueber unbekannt viele IDs werden deshalb in Bloecke zerlegt.
 */
const ID_CHUNK_SIZE = 400;

/** Ergebnis von INSERT: lastInsertRowid kommt als number|bigint zurueck. */
function insertedId(result: Database.RunResult): number {
  return Number(result.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// Obergrenzen
// ---------------------------------------------------------------------------

/** Harte Obergrenze beim Matching: das Tool liefert Kandidaten, keine Liste. */
const MATCH_LIMIT_MAX = 10;
const MATCH_LIMIT_DEFAULT = 10;

/** Hoechstzahl an Suchbegriffen pro Richtung - haelt die FTS-Query lesbar. */
const MATCH_MAX_TERMS = 24;

/** Hoechstzahl an Belegen pro Kandidat. */
const MATCH_MAX_EVIDENCE = 12;

/** Kandidaten, die aus dem Index geholt werden, bevor gefiltert wird. */
const MATCH_CANDIDATE_POOL = 200;

// ---------------------------------------------------------------------------
// Text-Normalisierung
// ---------------------------------------------------------------------------
// normalizeText liegt in lib/text.ts, weil lib/db.ts dieselbe Faltung als
// SQL-Funktion norm_text registriert (siehe city-Filter weiter unten).

/** Zerlegt Text in Wort-Token (Buchstaben und Ziffern), bereits normalisiert. */
function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0);
}

/**
 * Normalisierter Personenname fuer die Dedup-Map des Imports: Kleinschreibung,
 * ohne Akzente, Whitespace zusammengefasst. Bewusst keine Spalte im Schema -
 * der Import baut sich daraus zur Laufzeit eine Map.
 */
export function normalizePersonName(name: string): string {
  return normalizeText(name).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Tag-Namen: getrimmt, klein, Leerzeichen zu Bindestrich. */
export function normalizeTagName(name: string): string {
  return normalizeText(stripControlCharacters(name))
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * LinkedIn-URLs werden kanonisiert gespeichert und gesucht (https, Host klein,
 * ohne Query, ohne Fragment, ohne abschliessenden Slash). Nur so findet der
 * Import denselben Kontakt wieder, wenn der Export mal mit und mal ohne
 * "?originalSubdomain=de" oder Slash liefert. Laesst sich die URL nicht parsen,
 * bleibt der getrimmte Originaltext stehen.
 *
 * Zusaetzlich wird der Host vereinheitlicht: jeder linkedin.com-Host wird zu
 * www.linkedin.com. Die Laendersubdomains (de., uk., m., ...) zeigen bei
 * LinkedIn auf dasselbe Profil, sind also keine zweite Person.
 *
 * Diese Regel steht hier und NICHT im Import, obwohl nur der Import sie
 * braucht - sie muss beim Speichern, beim Suchen und beim Dublettenvergleich
 * dieselbe sein. Stuende sie nur im Import, entstuenden zwei kanonische Formen
 * desselben Werts: gespeichert wuerde 'https://de.linkedin.com/in/zoe', und
 * findContactByLinkedinUrl('https://www.linkedin.com/in/zoe') faende die Zeile
 * nicht, obwohl der Import sie sehr wohl als Dublette erkennt.
 *
 * Die Richtung ist mit Absicht "auf www ergaenzen" und nicht "www abschneiden":
 * so bleibt der haeufigste Fall (der Export liefert https://www.linkedin.com/…)
 * unveraendert, und die Faltung fasst nur zusaetzliche Varianten zusammen.
 */
export function normalizeLinkedinUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed === '') {
    return '';
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return trimmed;
  }
  const host = parsed.hostname.toLowerCase();
  const unifiedHost =
    host === 'linkedin.com' || host.endsWith('.linkedin.com') ? 'www.linkedin.com' : host;
  const path = parsed.pathname.replace(/\/+$/, '');
  return `https://${unifiedHost}${path}`;
}

/** Maskiert LIKE-Sonderzeichen, damit ein Praefix wie "a_b" woertlich sucht. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

// ---------------------------------------------------------------------------
// FTS5-Hilfen
// ---------------------------------------------------------------------------

/**
 * Wandelt freien Text in eine sichere FTS5-Query aus Praefix-Termen um.
 *
 * Ohne diese Behandlung sprengt jeder Apostroph, jedes Sternchen und jedes
 * "AND" der Nutzereingabe die FTS-Syntax und die Live-Suche wirft eine
 * Exception. Jedes Token wird deshalb als Phrase in doppelte Anfuehrungszeichen
 * gesetzt (enthaltene Anfuehrungszeichen verdoppelt) und bekommt aussen ein
 * Sternchen fuer die Praefix-Suche - "muster"* ist gueltige FTS5-Syntax,
 * muster* mit Sonderzeichen darin waere es nicht.
 *
 * Steuer- und Formatzeichen fliegen vorher aus jedem Token. Sie tragen zur
 * Suche nichts bei, und ein NUL laesst better-sqlite3 beim Binden des
 * MATCH-Parameters mit "unterminated string" abbrechen - bei einer Suche, die
 * an jedem Tastendruck haengt, waere das ein Absturz auf einer Nutzereingabe.
 *
 * WICHTIG - keine mehrwortigen Phrasen bauen: Jedes Token wird einzeln
 * gequotet und implizit mit AND verknuepft. Das ist Absicht. needs_text und
 * offers_text entstehen im Trigger ueber group_concat, mehrere getrennte Needs
 * verschmelzen dort also zu einem Tokenstrom. Eine echte Phrasenabfrage
 * ("wort1 wort2") kann deshalb ueber die Grenze zwischen zwei Needs hinweg
 * matchen, obwohl diese Wortfolge in keinem einzelnen Need vorkommt - siehe
 * den Regressionstest in tests/fts.regression.test.ts. Wer Phrasengenauigkeit
 * braucht, muesste needs/offers in eine eigene FTS-Tabelle mit einer Zeile pro
 * Eintrag auslagern; das widerspricht der bindenden Vorgabe
 * "rowid == contacts.id" und ist hier bewusst nicht gemacht.
 *
 * Rueckgabe null, wenn im Text kein einziges verwertbares Token steckt.
 */
export function toFtsPrefixQuery(text: string): string | null {
  const terms = text
    .split(/\s+/)
    .map((token) => stripSearchNoise(token.trim()))
    .filter((token) => /[\p{L}\p{N}]/u.test(token))
    .map(quoteFtsTerm);

  if (terms.length === 0) {
    return null;
  }
  return terms.join(' ');
}

/** Ein einzelnes Token als Praefix-Phrase. */
function quoteFtsTerm(token: string): string {
  return `"${token.replace(/"/g, '""')}"*`;
}

/** Verknuepft Terme mit OR - fuer das Matching, wo jeder Treffer zaehlt. */
function ftsAnyOf(terms: readonly string[]): string | null {
  const parts = terms.filter((term) => term.length > 0).map(quoteFtsTerm);
  if (parts.length === 0) {
    return null;
  }
  return parts.join(' OR ');
}

/** Beschraenkt einen Ausdruck auf bestimmte FTS-Spalten: {a b} : (expr). */
function ftsInColumns(columns: readonly string[], expression: string): string {
  return `{${columns.join(' ')}} : (${expression})`;
}

// ---------------------------------------------------------------------------
// zod-Schemas
// ---------------------------------------------------------------------------

const idSchema = z.number().int().positive();
const limitSchema = z.number().int().min(1).max(1000);

/** Obergrenze eines Suchbegriffs. Wird gekappt, nicht abgelehnt - siehe unten. */
const SEARCH_TEXT_MAX = 500;

/**
 * Fluechtiger Suchbegriff.
 *
 * Bewusst .transform(slice) statt .max(): ein eingefuegter Absatz oder eine
 * kopierte URL-Liste ist ueber 500 Zeichen schnell erreicht, und die Suche
 * laeuft an jedem Tastendruck. Ein ZodError waere dort die falsche Antwort -
 * gesucht wird dann eben nur mit dem Anfang. Fuer gespeicherte Felder bleibt
 * .max() richtig, dort ist Abschneiden Datenverlust.
 */
const searchTextSchema = z.string().transform((value) => value.slice(0, SEARCH_TEXT_MAX));

/**
 * Pflichttext (Name, Need, Offer, Notiz): nach dem Trimmen nicht leer.
 * Steuerzeichen fliegen raus, damit kein NUL in den Volltextindex wandert und
 * die Zeile danach unauffindbar macht. Tab und Zeilenumbruch bleiben erhalten.
 */
function cleanRequiredText(max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .transform((value) => stripControlCharacters(value).trim())
    .refine((value) => value.length > 0, 'Der Text besteht nur aus Steuerzeichen.');
}

const requiredText = cleanRequiredText(2000);

/**
 * Nullable Freitextfeld eines Kontakts. Ein leerer oder nur aus Whitespace
 * bestehender String wird zu null - so bleibt "leer" in der Datenbank ein
 * einziger Zustand und enrichContact muss nicht zwei Faelle unterscheiden.
 */
function nullableText(max: number) {
  return z
    .string()
    .max(max)
    .nullable()
    .transform((value) => {
      if (value === null) {
        return null;
      }
      const trimmed = stripControlCharacters(value).trim();
      return trimmed === '' ? null : trimmed;
    });
}

/** ISO-Datum mit optionalem Jahr: 1990-03-14 oder --03-14. */
const birthdaySchema = z
  .string()
  .nullable()
  .transform((value) => {
    if (value === null) {
      return null;
    }
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  })
  .refine(
    (value) => value === null || /^(\d{4}-\d{2}-\d{2}|--\d{2}-\d{2})$/.test(value),
    'birthday muss YYYY-MM-DD oder --MM-DD sein.',
  );

/** Datum oder Zeitstempel als ISO-String. */
const isoDateSchema = z
  .string()
  .trim()
  .min(4)
  .max(40)
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Kein gueltiges ISO-Datum.');

const nullableIsoDateSchema = isoDateSchema.nullable();

const closenessSchema = z.number().int().min(CLOSENESS_MIN).max(CLOSENESS_MAX).nullable();

/**
 * Die schreibbaren Kontaktfelder. newContactSchema und contactPatchSchema
 * leiten sich davon ab, damit beide nicht auseinanderlaufen koennen.
 */
const contactFieldSchemas = {
  name: cleanRequiredText(200),
  status: z.enum(CONTACT_STATUSES),
  stage: z.enum(STAGES),
  role: z.enum(ROLES).nullable(),
  company: nullableText(200),
  title: nullableText(200),
  city: nullableText(120),
  country: nullableText(120),
  email: nullableText(320),
  phone: nullableText(60),
  linkedin_url: nullableText(500).transform((value) =>
    value === null ? null : normalizeLinkedinUrl(value),
  ),
  birthday: birthdaySchema,
  how_we_met: nullableText(2000),
  closeness: closenessSchema,
  source: z.enum(SOURCES),
  last_contact_at: nullableIsoDateSchema,
} as const;

const newContactSchema = z.object({
  name: contactFieldSchemas.name,
  status: contactFieldSchemas.status.optional(),
  stage: contactFieldSchemas.stage.optional(),
  role: contactFieldSchemas.role.optional(),
  company: contactFieldSchemas.company.optional(),
  title: contactFieldSchemas.title.optional(),
  city: contactFieldSchemas.city.optional(),
  country: contactFieldSchemas.country.optional(),
  email: contactFieldSchemas.email.optional(),
  phone: contactFieldSchemas.phone.optional(),
  linkedin_url: contactFieldSchemas.linkedin_url.optional(),
  birthday: contactFieldSchemas.birthday.optional(),
  how_we_met: contactFieldSchemas.how_we_met.optional(),
  closeness: contactFieldSchemas.closeness.optional(),
  source: contactFieldSchemas.source.optional(),
  last_contact_at: contactFieldSchemas.last_contact_at.optional(),
  // created_at ist bei der Neuanlage schreibbar, weil der LinkedIn-Import
  // "Connected On" darauf abbildet.
  created_at: isoDateSchema.optional(),
});

const contactPatchSchema = z.object({
  name: contactFieldSchemas.name.optional(),
  status: contactFieldSchemas.status.optional(),
  stage: contactFieldSchemas.stage.optional(),
  role: contactFieldSchemas.role.optional(),
  company: contactFieldSchemas.company.optional(),
  title: contactFieldSchemas.title.optional(),
  city: contactFieldSchemas.city.optional(),
  country: contactFieldSchemas.country.optional(),
  email: contactFieldSchemas.email.optional(),
  phone: contactFieldSchemas.phone.optional(),
  linkedin_url: contactFieldSchemas.linkedin_url.optional(),
  birthday: contactFieldSchemas.birthday.optional(),
  how_we_met: contactFieldSchemas.how_we_met.optional(),
  closeness: contactFieldSchemas.closeness.optional(),
  source: contactFieldSchemas.source.optional(),
  last_contact_at: contactFieldSchemas.last_contact_at.optional(),
});

const contactFiltersSchema = z.object({
  status: contactFieldSchemas.status.optional(),
  stage: contactFieldSchemas.stage.optional(),
  role: z.enum(ROLES).optional(),
  city: z.string().trim().min(1).max(120).optional(),
  tag: z.string().trim().min(1).max(80).optional(),
  hasOpenNeeds: z.boolean().optional(),
  query: searchTextSchema.optional(),
});

const sortSchema = z.object({
  column: z.enum(['name', 'company', 'city', 'stage', 'last_contact_at', 'open_needs_count']),
  direction: z.enum(['asc', 'desc']).optional(),
});

const tagNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .transform(normalizeTagName)
  .refine((value) => value.length > 0, 'Der Tag-Name ist nach der Normalisierung leer.');

const matchParamsSchema = z
  .object({
    contactId: idSchema.optional(),
    query: searchTextSchema.optional(),
    // Ein zu grosses limit ist kein Fehler, es wird auf MATCH_LIMIT_MAX gekappt.
    limit: z.number().int().min(1).max(100).optional(),
  })
  .refine(
    (value) => value.contactId !== undefined || (value.query ?? '').trim() !== '',
    'findMatches braucht entweder contactId oder query.',
  );

// ---------------------------------------------------------------------------
// Sortierung
// ---------------------------------------------------------------------------

export const CONTACT_SORT_COLUMNS = [
  'name',
  'company',
  'city',
  'stage',
  'last_contact_at',
  'open_needs_count',
] as const;

export type ContactSortColumn = (typeof CONTACT_SORT_COLUMNS)[number];
export type SortDirection = 'asc' | 'desc';

export interface ContactSort {
  column: ContactSortColumn;
  direction?: SortDirection;
}

/**
 * Erzeugt das ORDER-BY-Fragment. Die Spalte kommt aus der Whitelist oben und
 * wird vorher von zod geprueft; die Richtung ist auf zwei Literale begrenzt.
 * Nullwerte landen unabhaengig von der Richtung immer am Ende, sonst steht
 * beim Sortieren nach "letzter Kontakt" die Haelfte des Adressbuchs oben.
 * Der Stage-Vergleich laeuft ueber ein CASE mit gebundenen Parametern, damit
 * die fachliche Reihenfolge aus STAGES gilt und nicht das Alphabet.
 */
function buildOrderBy(sort: ContactSort | undefined): { sql: string; params: unknown[] } {
  if (sort === undefined) {
    return { sql: 'ORDER BY c.name COLLATE NOCASE ASC, c.id ASC', params: [] };
  }

  const dir = sort.direction === 'desc' ? 'DESC' : 'ASC';
  const tail = 'c.name COLLATE NOCASE ASC, c.id ASC';

  switch (sort.column) {
    case 'name':
      return { sql: `ORDER BY c.name COLLATE NOCASE ${dir}, c.id ASC`, params: [] };
    case 'company':
      return {
        sql: `ORDER BY (c.company IS NULL) ASC, c.company COLLATE NOCASE ${dir}, ${tail}`,
        params: [],
      };
    case 'city':
      return {
        sql: `ORDER BY (c.city IS NULL) ASC, c.city COLLATE NOCASE ${dir}, ${tail}`,
        params: [],
      };
    case 'last_contact_at':
      return {
        sql: `ORDER BY (c.last_contact_at IS NULL) ASC, c.last_contact_at ${dir}, ${tail}`,
        params: [],
      };
    case 'open_needs_count':
      return { sql: `ORDER BY open_needs_count ${dir}, ${tail}`, params: [] };
    case 'stage': {
      const cases = STAGES.map((_, index) => `WHEN ? THEN ${index}`).join(' ');
      return {
        sql: `ORDER BY CASE c.stage ${cases} ELSE ${STAGES.length} END ${dir}, ${tail}`,
        params: [...STAGES],
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Spaltenlisten
// ---------------------------------------------------------------------------

const CONTACT_COLUMNS = [
  'id',
  'name',
  'status',
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
  'created_at',
  'updated_at',
] as const;

/** Schreibbare Spalten eines UPDATE auf contacts (created_at bleibt aussen vor). */
const CONTACT_PATCH_COLUMNS = [
  'name',
  'status',
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
] as const;

const CONTACT_SELECT = CONTACT_COLUMNS.map((column) => `c.${column}`).join(', ');
const CONTACT_SELECT_PLAIN = CONTACT_COLUMNS.join(', ');

const OPEN_NEEDS_COUNT_SELECT =
  '(SELECT COUNT(*) FROM needs n WHERE n.contact_id = c.id AND n.resolved_at IS NULL) AS open_needs_count';

// ---------------------------------------------------------------------------
// Kontakte: lesen
// ---------------------------------------------------------------------------

type ContactRowWithCount = Contact & { open_needs_count: number };

export function getContact(id: number): Contact | null {
  const contactId = idSchema.parse(id);
  return oneRow<Contact>(`SELECT ${CONTACT_SELECT_PLAIN} FROM contacts WHERE id = ?`, [contactId]);
}

/** Wie getContact, wirft aber statt null zurueckzugeben. */
function requireContact(id: number): Contact {
  const contact = getContact(id);
  if (contact === null) {
    throw new NotFoundError('Kontakt', id);
  }
  return contact;
}

/**
 * Listenansicht. Ohne gesetzten status-Filter werden archivierte Kontakte
 * ausgeblendet - das ist der Standardfilter der Oberflaeche.
 *
 * Die Volltextsuche haengt als JOIN auf contacts_fts in derselben Abfrage wie
 * alle uebrigen Filter. Das ist wichtig und nicht bloss huebscher: eine
 * vorgeschaltete Suche, die erst eine IN-Liste materialisiert und danach
 * gefiltert wird, muesste irgendwo gekappt werden - und alles jenseits der
 * Kappungsgrenze faellt heraus, bevor der Filter ueberhaupt greift. Bei einem
 * LinkedIn-Import mit ein paar tausend Kontakten und einer Praefixsuche ueber
 * zwei Buchstaben liefert die Suche dann still zu wenig oder gar nichts.
 *
 * Ist eine Volltextsuche gesetzt und keine Sortierung angefordert, sortiert
 * SQLite direkt nach dem bm25-Rang der Trefferzeile.
 */
export function listContacts(filters: ContactFilters = {}, sort?: ContactSort): ContactListRow[] {
  const parsedFilters = contactFiltersSchema.parse(filters);
  const parsedSort = sort === undefined ? undefined : sortSchema.parse(sort);

  const where: string[] = [];
  const params: unknown[] = [];

  if (parsedFilters.status !== undefined) {
    where.push('c.status = ?');
    params.push(parsedFilters.status);
  } else {
    where.push('c.status <> ?');
    params.push('archived');
  }

  if (parsedFilters.stage !== undefined) {
    where.push('c.stage = ?');
    params.push(parsedFilters.stage);
  }

  if (parsedFilters.role !== undefined) {
    where.push('c.role = ?');
    params.push(parsedFilters.role);
  }

  if (parsedFilters.city !== undefined) {
    // norm_text statt COLLATE NOCASE: NOCASE faltet nur ASCII, 'MÜNCHEN' wuerde
    // 'München' sonst nicht finden. Ein Index auf city gibt es ohnehin nicht.
    where.push('norm_text(c.city) = norm_text(?)');
    params.push(parsedFilters.city);
  }

  if (parsedFilters.tag !== undefined) {
    const tagName = normalizeTagName(parsedFilters.tag);
    if (tagName === '') {
      return [];
    }
    where.push(
      'EXISTS (SELECT 1 FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id ' +
        'WHERE ct.contact_id = c.id AND t.name = ?)',
    );
    params.push(tagName);
  }

  if (parsedFilters.hasOpenNeeds === true) {
    where.push('EXISTS (SELECT 1 FROM needs n WHERE n.contact_id = c.id AND n.resolved_at IS NULL)');
  } else if (parsedFilters.hasOpenNeeds === false) {
    where.push(
      'NOT EXISTS (SELECT 1 FROM needs n WHERE n.contact_id = c.id AND n.resolved_at IS NULL)',
    );
  }

  // Der JOIN steht im SQL vor dem WHERE, sein Parameter gehoert deshalb an den
  // Anfang der Parameterliste.
  let ftsJoin = '';
  const joinParams: unknown[] = [];
  let relevanceOrderSql: string | null = null;

  const rawQuery = (parsedFilters.query ?? '').trim();
  if (rawQuery !== '') {
    const ftsQuery = toFtsPrefixQuery(rawQuery);
    if (ftsQuery === null) {
      return [];
    }
    ftsJoin =
      'JOIN (SELECT rowid AS id, rank AS relevance FROM contacts_fts ' +
      'WHERE contacts_fts MATCH ?) fts ON fts.id = c.id';
    joinParams.push(ftsQuery);
    relevanceOrderSql = 'ORDER BY fts.relevance ASC, c.name COLLATE NOCASE ASC, c.id ASC';
  }

  const order =
    parsedSort === undefined && relevanceOrderSql !== null
      ? { sql: relevanceOrderSql, params: [] as unknown[] }
      : buildOrderBy(parsedSort);

  const sql =
    `SELECT ${CONTACT_SELECT}, ${OPEN_NEEDS_COUNT_SELECT} ` +
    `FROM contacts c ${ftsJoin} WHERE ${where.join(' AND ')} ${order.sql}`;

  const rows = allRows<ContactRowWithCount>(sql, [...joinParams, ...params, ...order.params]);

  const tagsByContact = loadTagNames(rows.map((row) => row.id));
  return rows.map((row) => ({ ...row, tags: tagsByContact.get(row.id) ?? [] }));
}

/**
 * Tag-Namen fuer viele Kontakte in einem Rutsch - eine Abfrage pro Block statt
 * einer pro Kontakt.
 */
function loadTagNames(contactIds: readonly number[]): Map<number, string[]> {
  const result = new Map<number, string[]>();
  if (contactIds.length === 0) {
    return result;
  }

  for (const block of chunk(contactIds, ID_CHUNK_SIZE)) {
    const rows = allRows<{ contact_id: number; name: string }>(
      'SELECT ct.contact_id AS contact_id, t.name AS name ' +
        'FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id ' +
        `WHERE ct.contact_id IN (${placeholders(block.length)}) ` +
        'ORDER BY t.name COLLATE NOCASE ASC',
      block,
    );
    for (const row of rows) {
      const existing = result.get(row.contact_id);
      if (existing === undefined) {
        result.set(row.contact_id, [row.name]);
      } else {
        existing.push(row.name);
      }
    }
  }

  return result;
}

/**
 * Ein Kontakt mit Needs, Offers und Tags. Notizen kommen nur mit
 * includeNotes === true mit - ohne das Flag ist das Feld gar nicht gesetzt,
 * damit die private Schicht nicht versehentlich mitfliesst.
 */
export function getContactDetail(
  id: number,
  opts?: { includeNotes?: boolean },
): ContactDetail | null {
  const contactId = idSchema.parse(id);
  const contact = getContact(contactId);
  if (contact === null) {
    return null;
  }

  const detail: ContactDetail = {
    ...contact,
    needs: listNeeds(contactId),
    offers: listOffers(contactId),
    tags: listTagsForContact(contactId),
  };

  if (opts?.includeNotes === true) {
    detail.notes = listNotes(contactId);
  }

  return detail;
}

// ---------------------------------------------------------------------------
// Kontakte: schreiben
// ---------------------------------------------------------------------------

/**
 * Neuer Kontakt. Manuell angelegte Kontakte sind sofort 'active'; ein
 * ausdruecklich mitgegebener Status gewinnt (den braucht der Import).
 */
export function createContact(input: NewContactInput): Contact {
  const parsed = newContactSchema.parse(input);
  return insertContact(parsed, parsed.status ?? 'active');
}

/** Wie createContact, aber immer mit status 'imported'. */
export function insertImportedContact(input: NewContactInput): Contact {
  const parsed = newContactSchema.parse(input);
  return insertContact(parsed, 'imported');
}

type ParsedNewContact = z.output<typeof newContactSchema>;

function insertContact(parsed: ParsedNewContact, status: ContactStatus): Contact {
  const timestamp = nowIso();

  return withTransaction(() => {
    const result = runSql(
      `INSERT INTO contacts (${CONTACT_COLUMNS.filter((column) => column !== 'id').join(', ')}) ` +
        `VALUES (${placeholders(CONTACT_COLUMNS.length - 1)})`,
      [
        parsed.name,
        status,
        parsed.stage ?? 'new',
        parsed.role ?? null,
        parsed.company ?? null,
        parsed.title ?? null,
        parsed.city ?? null,
        parsed.country ?? null,
        parsed.email ?? null,
        parsed.phone ?? null,
        parsed.linkedin_url ?? null,
        parsed.birthday ?? null,
        parsed.how_we_met ?? null,
        parsed.closeness ?? null,
        parsed.source ?? 'manual',
        parsed.last_contact_at ?? null,
        parsed.created_at ?? timestamp,
        timestamp,
      ],
    );
    return requireContact(insertedId(result));
  });
}

/**
 * Teiländerung eines Kontakts.
 *
 * Zwei Regeln stecken hier drin:
 *   - updated_at wird immer mitgesetzt.
 *   - Wird ein importierter Kontakt bearbeitet, gilt er als uebernommen und
 *     wechselt auf 'active'. 'archived' bleibt unangetastet, und ein im Patch
 *     ausdruecklich gesetzter Status gewinnt.
 *
 * Ein leerer Patch ist ein No-Op: er aendert nichts und bumpt auch updated_at
 * nicht, damit ein Formular ohne Aenderung keine Historie erzeugt.
 */
export function updateContact(id: number, patch: ContactPatch): Contact {
  const contactId = idSchema.parse(id);
  const parsed = contactPatchSchema.parse(patch);

  return withTransaction(() => {
    const current = requireContact(contactId);

    const assignments: string[] = [];
    const params: unknown[] = [];

    for (const column of CONTACT_PATCH_COLUMNS) {
      const value = parsed[column];
      // undefined heisst "nicht gesetzt", null heisst "leeren".
      if (value === undefined) {
        continue;
      }
      assignments.push(`${column} = ?`);
      params.push(value);
    }

    if (assignments.length === 0) {
      return current;
    }

    if (parsed.status === undefined && current.status === 'imported') {
      assignments.push('status = ?');
      params.push('active');
    }

    assignments.push('updated_at = ?');
    params.push(nowIso());

    runSql(`UPDATE contacts SET ${assignments.join(', ')} WHERE id = ?`, [...params, contactId]);
    return requireContact(contactId);
  });
}

/**
 * Stage setzen. Laeuft bewusst ueber updateContact, damit die
 * imported-zu-active-Regel auch beim Verschieben im Board greift.
 */
export function setStage(id: number, stage: Stage): Contact {
  return updateContact(id, { stage: z.enum(STAGES).parse(stage) });
}

/**
 * Status direkt setzen. Hier greift die imported-Regel nicht - der Aufrufer
 * sagt ja gerade ausdruecklich, welcher Status gelten soll.
 */
export function setStatus(id: number, status: ContactStatus): Contact {
  const contactId = idSchema.parse(id);
  const nextStatus = z.enum(CONTACT_STATUSES).parse(status);

  return withTransaction(() => {
    requireContact(contactId);
    runSql('UPDATE contacts SET status = ?, updated_at = ? WHERE id = ?', [
      nextStatus,
      nowIso(),
      contactId,
    ]);
    return requireContact(contactId);
  });
}

/**
 * Loescht den Kontakt samt Needs, Offers, Notizen, Tags und Connections (Cascade).
 *
 * Wirft NotFoundError, wenn es die Zeile nicht gibt - wie jede andere
 * schreibende Funktion dieser Datei auch. Ein stiller No-Op waere hier
 * schaedlich: die aufrufende Schicht koennte "geloescht" und "gab es nie"
 * nicht unterscheiden und deshalb kein 404 abbilden.
 */
export function deleteContact(id: number): void {
  const contactId = idSchema.parse(id);
  withTransaction(() => {
    const result = runSql('DELETE FROM contacts WHERE id = ?', [contactId]);
    if (result.changes === 0) {
      throw new NotFoundError('Kontakt', contactId);
    }
  });
}

/**
 * Fuellt ausschliesslich Felder, die aktuell NULL oder leer sind. Bereits
 * gefuellte Werte bleiben stehen - das ist die Funktion, die der Import bei
 * einem Dublettentreffer benutzt ("ergaenzen, nicht ueberschreiben").
 *
 * Der Status bleibt ausdruecklich unangetastet: ein Import soll aus einem
 * gepflegten 'active'-Kontakt nichts anderes machen und aus einem
 * 'imported'-Kontakt auch nicht.
 *
 * WICHTIGE FOLGE, die man kennen muss: "leer" heisst hier NULL oder leerer
 * String, und diese Funktion kann "noch nie gefuellt" nicht von "vom Menschen
 * bewusst geleert" unterscheiden. Wer einen falschen Firmennamen loescht
 * (updateContact({ company: null })), bekommt ihn beim naechsten Import
 * derselben Datei erneut eingetragen - und zwar bei jedem Lauf wieder. Eine
 * geAENDERTE Angabe gewinnt dauerhaft gegen den Import, eine geLOESCHTE nicht.
 * Wer einen Wert endgueltig loswerden will, muss ihn in der Quelldatei
 * korrigieren. (Die Alternative waere eine Markierung geleerter Felder, die
 * enrichContact respektiert; die gibt es bewusst nicht, weil sie jedem
 * einzelnen Feld einen zweiten Zustand gaebe.)
 */
export function enrichContact(id: number, patch: ContactPatch): Contact {
  const contactId = idSchema.parse(id);
  const parsed = contactPatchSchema.parse(patch);

  return withTransaction(() => {
    const current = requireContact(contactId);

    const assignments: string[] = [];
    const params: unknown[] = [];

    for (const column of CONTACT_PATCH_COLUMNS) {
      if (column === 'status') {
        continue;
      }
      const value = parsed[column];
      if (value === undefined || value === null) {
        continue;
      }
      const existing: unknown = current[column];
      if (existing !== null && existing !== '') {
        continue;
      }
      assignments.push(`${column} = ?`);
      params.push(value);
    }

    if (assignments.length === 0) {
      return current;
    }

    assignments.push('updated_at = ?');
    params.push(nowIso());

    runSql(`UPDATE contacts SET ${assignments.join(', ')} WHERE id = ?`, [...params, contactId]);
    return requireContact(contactId);
  });
}

// ---------------------------------------------------------------------------
// Needs und Offers
// ---------------------------------------------------------------------------

/**
 * needs und offers sind strukturgleich. Die Tabellennamen kommen aus diesem
 * Literal-Typ und nie von aussen, deshalb duerfen sie in SQL interpoliert
 * werden.
 */
type ItemTable = 'needs' | 'offers';

const ITEM_COLUMNS = 'id, contact_id, text, created_at, resolved_at';

/** Offene Eintraege zuerst, danach die aeltesten - so liest sich die Detailansicht. */
const ITEM_ORDER = 'ORDER BY (resolved_at IS NOT NULL) ASC, created_at ASC, id ASC';

function addItem(table: ItemTable, contactId: number, text: string): Need {
  const id = idSchema.parse(contactId);
  const body = requiredText.parse(text);

  return withTransaction(() => {
    requireContact(id);
    const result = runSql(
      `INSERT INTO ${table} (contact_id, text, created_at, resolved_at) VALUES (?, ?, ?, NULL)`,
      [id, body, nowIso()],
    );
    return requireItem(table, insertedId(result));
  });
}

function requireItem(table: ItemTable, id: number): Need {
  const row = oneRow<Need>(`SELECT ${ITEM_COLUMNS} FROM ${table} WHERE id = ?`, [id]);
  if (row === null) {
    throw new NotFoundError(table === 'needs' ? 'Need' : 'Offer', id);
  }
  return row;
}

/** Erledigt heisst resolved_at setzen, nicht loeschen. */
function setItemResolved(table: ItemTable, id: number, resolved: boolean): Need {
  const itemId = idSchema.parse(id);

  return withTransaction(() => {
    requireItem(table, itemId);
    runSql(`UPDATE ${table} SET resolved_at = ? WHERE id = ?`, [resolved ? nowIso() : null, itemId]);
    return requireItem(table, itemId);
  });
}

function updateItemText(table: ItemTable, id: number, text: string): Need {
  const itemId = idSchema.parse(id);
  const body = requiredText.parse(text);

  return withTransaction(() => {
    requireItem(table, itemId);
    runSql(`UPDATE ${table} SET text = ? WHERE id = ?`, [body, itemId]);
    return requireItem(table, itemId);
  });
}

function deleteItem(table: ItemTable, id: number): void {
  const itemId = idSchema.parse(id);
  withTransaction(() => {
    const result = runSql(`DELETE FROM ${table} WHERE id = ?`, [itemId]);
    if (result.changes === 0) {
      throw new NotFoundError(table === 'needs' ? 'Need' : 'Offer', itemId);
    }
  });
}

function listItems(table: ItemTable, contactId: number, openOnly: boolean): Need[] {
  const id = idSchema.parse(contactId);
  const filter = openOnly ? ' AND resolved_at IS NULL' : '';
  return allRows<Need>(
    `SELECT ${ITEM_COLUMNS} FROM ${table} WHERE contact_id = ?${filter} ${ITEM_ORDER}`,
    [id],
  );
}

export function addNeed(contactId: number, text: string): Need {
  return addItem('needs', contactId, text);
}

export function addOffer(contactId: number, text: string): Offer {
  return addItem('offers', contactId, text);
}

export function resolveNeed(id: number): Need {
  return setItemResolved('needs', id, true);
}

export function unresolveNeed(id: number): Need {
  return setItemResolved('needs', id, false);
}

export function resolveOffer(id: number): Offer {
  return setItemResolved('offers', id, true);
}

export function unresolveOffer(id: number): Offer {
  return setItemResolved('offers', id, false);
}

export function updateNeedText(id: number, text: string): Need {
  return updateItemText('needs', id, text);
}

export function updateOfferText(id: number, text: string): Offer {
  return updateItemText('offers', id, text);
}

export function deleteNeed(id: number): void {
  deleteItem('needs', id);
}

export function deleteOffer(id: number): void {
  deleteItem('offers', id);
}

export function listNeeds(contactId: number, opts?: { openOnly?: boolean }): Need[] {
  return listItems('needs', contactId, opts?.openOnly === true);
}

export function listOffers(contactId: number, opts?: { openOnly?: boolean }): Offer[] {
  return listItems('offers', contactId, opts?.openOnly === true);
}

// ---------------------------------------------------------------------------
// Notizen
// ---------------------------------------------------------------------------

const NOTE_COLUMNS = 'id, contact_id, body, occurred_on, created_at';

/**
 * occurred_on muss ein Datum sein, das es wirklich gibt.
 *
 * Die Form allein reicht nicht: "9999-99-99" und "2026-02-31" passen auf das
 * Muster, bezeichnen aber keinen Tag. Der Wert wandert von hier aus nach
 * contacts.last_contact_at, und der Vergleich dort ist ein reiner
 * Stringvergleich - ein solcher Unwert stuende also dauerhaft vorn und keine
 * spaetere echte Notiz koennte ihn je wieder ueberholen.
 *
 * Der Abgleich mit dem zurueckformatierten Date faengt beides ab: unmoegliche
 * Zahlen und Tage, die es im jeweiligen Monat nicht gibt.
 */
const occurredOnSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'occurred_on muss YYYY-MM-DD sein.')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) {
      return false;
    }
    return parsed.toISOString().slice(0, 10) === value;
  }, 'occurred_on muss ein gueltiges Kalenderdatum sein.');

/**
 * Notiz anlegen. occurred_on ist standardmaessig heute.
 *
 * Zusatzregel: eine Notiz ist der Beleg dafuer, dass Kontakt stattgefunden hat.
 * Deshalb wandert contacts.last_contact_at auf occurred_on, sofern das Datum
 * spaeter ist als der bisherige Wert (oder noch keiner gesetzt war). Aeltere
 * Notizen, die man nachtraegt, ziehen den letzten Kontakt also nicht zurueck.
 */
export function addNote(contactId: number, body: string, occurredOn?: string): Note {
  const id = idSchema.parse(contactId);
  const text = requiredText.parse(body);
  const date = occurredOn === undefined ? todayIso() : occurredOnSchema.parse(occurredOn);

  return withTransaction(() => {
    requireContact(id);

    const result = runSql(
      'INSERT INTO notes (contact_id, body, occurred_on, created_at) VALUES (?, ?, ?, ?)',
      [id, text, date, nowIso()],
    );

    runSql(
      'UPDATE contacts SET last_contact_at = ?, updated_at = ? ' +
        'WHERE id = ? AND (last_contact_at IS NULL OR last_contact_at < ?)',
      [date, nowIso(), id, date],
    );

    const note = oneRow<Note>(`SELECT ${NOTE_COLUMNS} FROM notes WHERE id = ?`, [
      insertedId(result),
    ]);
    if (note === null) {
      throw new NotFoundError('Notiz', insertedId(result));
    }
    return note;
  });
}

/** Notizen, neueste zuerst. */
export function listNotes(contactId: number): Note[] {
  const id = idSchema.parse(contactId);
  return allRows<Note>(
    `SELECT ${NOTE_COLUMNS} FROM notes WHERE contact_id = ? ` +
      'ORDER BY (occurred_on IS NULL) ASC, occurred_on DESC, created_at DESC, id DESC',
    [id],
  );
}

export function deleteNote(id: number): void {
  const noteId = idSchema.parse(id);
  withTransaction(() => {
    const result = runSql('DELETE FROM notes WHERE id = ?', [noteId]);
    if (result.changes === 0) {
      throw new NotFoundError('Notiz', noteId);
    }
  });
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export function listTags(): Tag[] {
  return allRows<Tag>('SELECT id, name FROM tags ORDER BY name COLLATE NOCASE ASC');
}

/** Autovervollstaendigung: alle Tags, die mit dem Praefix beginnen. */
export function searchTags(prefix: string): Tag[] {
  const normalized = normalizeTagName(prefix);
  if (normalized === '') {
    return listTags();
  }
  return allRows<Tag>(
    "SELECT id, name FROM tags WHERE name LIKE ? ESCAPE '\\' ORDER BY name COLLATE NOCASE ASC",
    [`${escapeLike(normalized)}%`],
  );
}

export function getOrCreateTag(name: string): Tag {
  const tagName = tagNameSchema.parse(name);

  return withTransaction(() => {
    const existing = oneRow<Tag>('SELECT id, name FROM tags WHERE name = ?', [tagName]);
    if (existing !== null) {
      return existing;
    }
    const result = runSql('INSERT INTO tags (name) VALUES (?)', [tagName]);
    return { id: insertedId(result), name: tagName };
  });
}

/** Haengt einen Tag an einen Kontakt und legt ihn bei Bedarf an. */
export function addTagToContact(contactId: number, tagName: string): Tag {
  const id = idSchema.parse(contactId);

  return withTransaction(() => {
    requireContact(id);
    const tag = getOrCreateTag(tagName);
    runSql('INSERT OR IGNORE INTO contact_tags (contact_id, tag_id) VALUES (?, ?)', [id, tag.id]);
    return tag;
  });
}

/**
 * Loest die Verknuepfung zwischen Kontakt und Tag.
 *
 * Bewusst spiegelbildlich zu addTagToContact: der Kontakt muss existieren
 * (sonst NotFoundError, die Oberflaeche kann 404 zeigen), eine gar nicht
 * vorhandene Verknuepfung ist dagegen kein Fehler. addTagToContact haengt
 * ueber INSERT OR IGNORE genauso idempotent an - beide Richtungen stellen
 * einen Zielzustand her, statt eine Zustandsaenderung zu verlangen.
 */
export function removeTagFromContact(contactId: number, tagId: number): void {
  const id = idSchema.parse(contactId);
  const tag = idSchema.parse(tagId);
  withTransaction(() => {
    requireContact(id);
    runSql('DELETE FROM contact_tags WHERE contact_id = ? AND tag_id = ?', [id, tag]);
  });
}

export function listTagsForContact(contactId: number): Tag[] {
  const id = idSchema.parse(contactId);
  return allRows<Tag>(
    'SELECT t.id AS id, t.name AS name FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id ' +
      'WHERE ct.contact_id = ? ORDER BY t.name COLLATE NOCASE ASC',
    [id],
  );
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

const CONNECTION_COLUMNS = 'id, contact_a_id, contact_b_id, note, created_at';

/**
 * Verbindung zwischen zwei Kontakten. Das Paar wird immer so normalisiert,
 * dass a < b - zusaetzlich zum CHECK-Constraint im Schema.
 *
 * Entscheidung fuer den Dublettenfall: dasselbe Paar erneut einzufuegen wirft
 * nicht, sondern aktualisiert die Notiz, sofern eine mitgegeben wurde. Ohne
 * Notiz ist es ein No-Op. Begruendung: der Aufrufer will "diese beiden kennen
 * sich" festhalten - dass das schon jemand notiert hat, ist kein Fehler, und
 * eine mitgeschickte Notiz waere sonst stillschweigend verloren.
 */
export function addConnection(aId: number, bId: number, note?: string): Connection {
  const first = idSchema.parse(aId);
  const second = idSchema.parse(bId);
  if (first === second) {
    throw new Error('Ein Kontakt kann nicht mit sich selbst verbunden werden.');
  }
  const noteText = note === undefined ? null : nullableText(2000).parse(note);

  const low = Math.min(first, second);
  const high = Math.max(first, second);

  return withTransaction(() => {
    requireContact(low);
    requireContact(high);

    const existing = oneRow<Connection>(
      `SELECT ${CONNECTION_COLUMNS} FROM connections WHERE contact_a_id = ? AND contact_b_id = ?`,
      [low, high],
    );

    if (existing !== null) {
      if (noteText === null) {
        return existing;
      }
      runSql('UPDATE connections SET note = ? WHERE id = ?', [noteText, existing.id]);
      return { ...existing, note: noteText };
    }

    const result = runSql(
      'INSERT INTO connections (contact_a_id, contact_b_id, note, created_at) VALUES (?, ?, ?, ?)',
      [low, high, noteText, nowIso()],
    );

    const created = oneRow<Connection>(
      `SELECT ${CONNECTION_COLUMNS} FROM connections WHERE id = ?`,
      [insertedId(result)],
    );
    if (created === null) {
      throw new NotFoundError('Connection', insertedId(result));
    }
    return created;
  });
}

/** Alle Verbindungen, an denen dieser Kontakt beteiligt ist. */
export function listConnections(contactId: number): Connection[] {
  const id = idSchema.parse(contactId);
  return allRows<Connection>(
    `SELECT ${CONNECTION_COLUMNS} FROM connections WHERE contact_a_id = ? OR contact_b_id = ? ` +
      'ORDER BY created_at DESC, id DESC',
    [id, id],
  );
}

export function deleteConnection(id: number): void {
  const connectionId = idSchema.parse(id);
  withTransaction(() => {
    const result = runSql('DELETE FROM connections WHERE id = ?', [connectionId]);
    if (result.changes === 0) {
      throw new NotFoundError('Connection', connectionId);
    }
  });
}

// ---------------------------------------------------------------------------
// Suche und Import-Stuetzen
// ---------------------------------------------------------------------------

/**
 * Volltextsuche ueber contacts_fts, IDs in Relevanzreihenfolge (bm25).
 * Der Suchtext wird ueber toFtsPrefixQuery entschaerft; enthaelt er kein
 * verwertbares Token, ist das Ergebnis leer statt einer Exception.
 */
export function searchContactsFts(query: string, limit = 50): number[] {
  const text = searchTextSchema.parse(query);
  const max = limitSchema.parse(limit);

  const ftsQuery = toFtsPrefixQuery(text);
  if (ftsQuery === null) {
    return [];
  }

  const rows = allRows<{ id: number }>(
    'SELECT rowid AS id FROM contacts_fts WHERE contacts_fts MATCH ? ORDER BY rank LIMIT ?',
    [ftsQuery, max],
  );
  return rows.map((row) => row.id);
}

/** Dublettenpruefung des Imports, Stufe 1. */
export function findContactByLinkedinUrl(url: string): Contact | null {
  const normalized = normalizeLinkedinUrl(z.string().max(500).parse(url));
  if (normalized === '') {
    return null;
  }
  return oneRow<Contact>(
    `SELECT ${CONTACT_SELECT_PLAIN} FROM contacts WHERE linkedin_url = ? COLLATE NOCASE ORDER BY id ASC`,
    [normalized],
  );
}

/** Dublettenpruefung des Imports, Stufe 2. */
export function findContactByEmail(email: string): Contact | null {
  const trimmed = z.string().max(320).parse(email).trim();
  if (trimmed === '') {
    return null;
  }
  return oneRow<Contact>(
    `SELECT ${CONTACT_SELECT_PLAIN} FROM contacts WHERE email = ? COLLATE NOCASE ORDER BY id ASC`,
    [trimmed],
  );
}

export interface DedupRow {
  id: number;
  name: string;
  email: string | null;
  linkedin_url: string | null;
}

/**
 * Grundlage fuer die In-Memory-Dedup-Map des Imports (Stufe 3: normalisierter
 * Name). Bewusst ohne zusaetzliche Spalte im Schema - der Import normalisiert
 * mit normalizePersonName selbst.
 */
export function getAllContactsForDedup(): DedupRow[] {
  return allRows<DedupRow>('SELECT id, name, email, linkedin_url FROM contacts ORDER BY id ASC');
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

/**
 * Board-Karte: Listenzeile plus der oberste offene Need (der aelteste), damit
 * die Karte ohne Nachladen anzeigen kann, woran die Person gerade sitzt.
 */
export type BoardContactRow = ContactListRow & { top_open_need: string | null };

/** Kanban nach Stage, nur aktive Kontakte. Jede Stage ist im Ergebnis vertreten. */
export function listBoardContacts(): Record<Stage, BoardContactRow[]> {
  const rows = listContacts({ status: 'active' });
  const topNeeds = loadTopOpenNeeds(rows.map((row) => row.id));

  const board: Record<Stage, BoardContactRow[]> = {
    new: [],
    reached_out: [],
    in_touch: [],
    close: [],
    dormant: [],
  };

  for (const row of rows) {
    board[row.stage].push({ ...row, top_open_need: topNeeds.get(row.id) ?? null });
  }

  return board;
}

/** Aeltester offener Need je Kontakt, in einer Abfrage pro Block. */
function loadTopOpenNeeds(contactIds: readonly number[]): Map<number, string> {
  const result = new Map<number, string>();
  if (contactIds.length === 0) {
    return result;
  }

  for (const block of chunk(contactIds, ID_CHUNK_SIZE)) {
    const rows = allRows<{ contact_id: number; text: string }>(
      'SELECT contact_id, text FROM needs ' +
        `WHERE resolved_at IS NULL AND contact_id IN (${placeholders(block.length)}) ` +
        'ORDER BY created_at ASC, id ASC',
      block,
    );
    for (const row of rows) {
      if (!result.has(row.contact_id)) {
        result.set(row.contact_id, row.text);
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Sehr kurze und sehr generische Woerter tragen nichts zur Uebereinstimmung
 * bei - ohne diese Liste matcht jeder Kontakt auf "und", "the" oder "suche".
 * Die Liste wird beim Aufbau normalisiert, damit "fuer"/"für" beide greifen.
 */
const STOPWORDS: ReadonlySet<string> = new Set(
  [
    // Deutsch
    'und', 'oder', 'aber', 'denn', 'doch', 'nicht', 'auch', 'noch', 'schon', 'sehr',
    'mehr', 'alle', 'alles', 'etwas', 'jemand', 'gerne', 'gern', 'immer', 'viel', 'viele',
    'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'eines',
    'ich', 'mir', 'mich', 'wir', 'uns', 'ihr', 'sie', 'man', 'wer', 'was', 'wie', 'wo', 'wann',
    'ist', 'sind', 'war', 'waren', 'hat', 'habe', 'haben', 'kann', 'können', 'will', 'wollen',
    'möchte', 'suche', 'suchen', 'sucht', 'biete', 'bieten', 'bietet', 'brauche', 'brauchen',
    'braucht', 'für', 'mit', 'von', 'vom', 'zum', 'zur', 'auf', 'aus', 'bei', 'nach', 'über',
    'unter', 'dass', 'weil', 'wenn', 'sich', 'jemanden', 'thema', 'gerade', 'aktuell',
    // Englisch
    'and', 'the', 'for', 'with', 'from', 'into', 'about', 'that', 'this', 'these', 'those',
    'are', 'was', 'were', 'been', 'have', 'has', 'had', 'can', 'could', 'will', 'would',
    'should', 'need', 'needs', 'needed', 'looking', 'look', 'want', 'wants', 'offer', 'offers',
    'offering', 'help', 'helping', 'some', 'any', 'all', 'more', 'most', 'very', 'just',
    'who', 'what', 'where', 'when', 'why', 'how', 'out', 'than', 'then', 'also', 'not',
    'but', 'get', 'got', 'someone', 'anyone', 'currently',
  ].map(normalizeText),
);

/** Ab dieser Laenge darf ein Begriff als Praefix gesucht werden. */
const MIN_PREFIX_TERM_LENGTH = 3;

/**
 * Darf dieser Begriff als Praefix gesucht werden?
 *
 * Freitext laeuft ohnehin durch extractTerms und erfuellt die Bedingung immer.
 * Tag-Namen dagegen kommen ungefiltert aus der Datenbank, und ein sehr kurzer
 * oder generischer Tag als Praefix trifft alles: der Tag 'b' wuerde ueber
 * LIKE 'b%' jeden 'biotech'-Kontakt einsammeln, der Tag 'suche' jeden
 * 'suchen'-Kontakt. Solche Begriffe werden deshalb nur noch exakt verglichen -
 * sie ganz zu verwerfen waere zu grob, zweibuchstabige Tags wie 'ai' oder 'hr'
 * sind echte Merkmale und sollen sich weiterhin gegenseitig finden.
 */
function isPrefixCapableTerm(term: string): boolean {
  return term.length >= MIN_PREFIX_TERM_LENGTH && !STOPWORDS.has(term);
}

/** Trifft dieser Begriff diesen Tag-Namen? Tags sind kontrolliertes Vokabular. */
function tagMatchesTerm(tagName: string, term: string): boolean {
  const name = normalizeText(tagName);
  return name === term || (isPrefixCapableTerm(term) && name.startsWith(term));
}

/** Verwertbare Suchbegriffe aus freiem Text: normalisiert, ohne Stoppworte. */
function extractTerms(text: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const token of tokenize(text)) {
    if (!isPrefixCapableTerm(token) || seen.has(token)) {
      continue;
    }
    seen.add(token);
    terms.push(token);
    if (terms.length >= MATCH_MAX_TERMS) {
      break;
    }
  }
  return terms;
}

interface FtsHit {
  id: number;
  rank: number;
}

/**
 * FTS-Treffer inklusive bm25-Rang (kleiner ist besser), bereits auf aktive
 * Kontakte eingeschraenkt.
 *
 * Der Statusfilter steht hier drin und NICHT beim Aufrufer, und das ist der
 * ganze Witz an dieser Funktion. Stuende er dahinter, wuerde das LIMIT auf der
 * ungefilterten Trefferliste wirken: bei einem LinkedIn-Import mit tausenden
 * 'imported'-Kontakten fuellen genau die den Pool und verdraengen die wenigen
 * kuratierten 'active'-Kontakte restlos. find_matches meldete dann "keine
 * Kandidaten", obwohl gute existieren - und zwar stumm.
 *
 * Gemessen an einem Bestand mit fuenf passenden aktiven Kontakten: bei 100
 * importierten Zeilen kamen noch alle fuenf durch, bei 199 nur einer, ab 250
 * keiner mehr. Dieselbe Falle ist bei listContacts oben schon einmal
 * zugeschnappt und dort auf demselben Weg geloest - Suche und Filter gehoeren
 * in EINE Abfrage.
 */
function ftsSearch(matchExpression: string, limit: number): FtsHit[] {
  return allRows<FtsHit>(
    'SELECT f.rowid AS id, f.rank AS rank FROM contacts_fts f ' +
      'JOIN contacts c ON c.id = f.rowid ' +
      "WHERE contacts_fts MATCH ? AND c.status = 'active' " +
      'ORDER BY f.rank LIMIT ?',
    [matchExpression, limit],
  );
}

/**
 * Kandidaten fuer eine Verkupplung.
 *
 * Prinzip: die offenen NEEDS der einen Seite treffen auf die offenen OFFERS
 * der anderen - und umgekehrt. Dazu Tag-Ueberlappung. Ausgangspunkt ist
 * entweder ein Kontakt (dessen offene Needs/Offers) oder ein Freitext.
 *
 * Bewusst OHNE Score: die Reihenfolge folgt intern der FTS-Relevanz, aber nach
 * aussen gibt es nur Kandidaten mit konkreten Belegen. Eine Zahl wuerde eine
 * Sicherheit behaupten, die Keyword-Ueberlappung nicht hergibt; die Bewertung
 * gehoert zum aufrufenden Modell beziehungsweise zum Menschen.
 */
export function findMatches(params: {
  contactId?: number;
  query?: string;
  limit?: number;
}): MatchCandidate[] {
  const parsed = matchParamsSchema.parse(params);
  const limit = Math.min(parsed.limit ?? MATCH_LIMIT_DEFAULT, MATCH_LIMIT_MAX);
  const queryText = (parsed.query ?? '').trim();
  const queryTerms = queryText === '' ? [] : extractTerms(queryText);

  let sourceNeedTerms: string[] = [];
  let sourceOfferTerms: string[] = [];
  let sourceTags: string[] = [];

  if (parsed.contactId !== undefined) {
    // Wirft, wenn es den Ausgangskontakt nicht gibt - stiller Leerlauf waere
    // hier irrefuehrend.
    requireContact(parsed.contactId);
    sourceNeedTerms = extractTerms(
      listNeeds(parsed.contactId, { openOnly: true })
        .map((need) => need.text)
        .join(' '),
    );
    sourceOfferTerms = extractTerms(
      listOffers(parsed.contactId, { openOnly: true })
        .map((offer) => offer.text)
        .join(' '),
    );
    sourceTags = listTagsForContact(parsed.contactId).map((tag) => tag.name);
  }

  // Was der Ausgangspunkt sucht, muss in den Offers der Kandidaten stehen -
  // und was er anbietet, in deren Needs. Ein Freitext zaehlt fuer beides.
  const termsForCandidateOffers = mergeTerms(sourceNeedTerms, queryTerms);
  const termsForCandidateNeeds = mergeTerms(sourceOfferTerms, queryTerms);

  const bestRank = new Map<number, number>();
  const noteHit = (hits: FtsHit[]): void => {
    for (const hit of hits) {
      const previous = bestRank.get(hit.id);
      if (previous === undefined || hit.rank < previous) {
        bestRank.set(hit.id, hit.rank);
      }
    }
  };

  const offerExpression = ftsAnyOf(termsForCandidateOffers);
  if (offerExpression !== null) {
    noteHit(ftsSearch(ftsInColumns(['offers_text'], offerExpression), MATCH_CANDIDATE_POOL));
  }

  const needExpression = ftsAnyOf(termsForCandidateNeeds);
  if (needExpression !== null) {
    noteHit(ftsSearch(ftsInColumns(['needs_text'], needExpression), MATCH_CANDIDATE_POOL));
  }

  // Nur beim Freitext zaehlt auch das Profil: wer "Healthtech" sucht, meint
  // womoeglich die Person, bei der das in der Firma oder im Titel steht.
  // Der Name ist hier bewusst NICHT dabei. Zwei Gruende: eine Namensgleichheit
  // ist kein Grund, zwei Menschen zu verkuppeln - und ein Namenstreffer haette
  // ohnehin keinen Beleg, weil collectEvidence die Profil-Belege nur aus
  // company, title und how_we_met baut. Solche Kandidaten fielen unten still
  // wieder heraus und haetten vorher nur Plaetze im Pool verbraucht.
  // Wer eine bestimmte Person sucht, nimmt search_contacts.
  const profileExpression = ftsAnyOf(queryTerms);
  if (profileExpression !== null) {
    noteHit(
      ftsSearch(
        ftsInColumns(['company', 'title', 'how_we_met'], profileExpression),
        MATCH_CANDIDATE_POOL,
      ),
    );
  }

  const tagTerms = mergeTerms(sourceTags, queryTerms);
  const tagCandidates = findContactsByTags(tagTerms);
  for (const id of tagCandidates) {
    if (!bestRank.has(id)) {
      // Reine Tag-Treffer haben keinen bm25-Rang und landen hinter den
      // Volltexttreffern.
      bestRank.set(id, Number.POSITIVE_INFINITY);
    }
  }

  const candidateIds = [...bestRank.keys()].filter((id) => id !== parsed.contactId);
  if (candidateIds.length === 0) {
    return [];
  }

  const contacts = loadActiveContacts(candidateIds);
  if (contacts.length === 0) {
    return [];
  }

  const activeIds = contacts.map((contact) => contact.id);
  const openNeeds = loadOpenItems('needs', activeIds);
  const openOffers = loadOpenItems('offers', activeIds);
  const tagsByContact = loadTagNames(activeIds);

  const candidates: MatchCandidate[] = [];

  for (const contact of contacts) {
    const evidence: MatchEvidence[] = [];

    collectEvidence(evidence, 'offer', openOffers.get(contact.id) ?? [], termsForCandidateOffers);
    collectEvidence(evidence, 'need', openNeeds.get(contact.id) ?? [], termsForCandidateNeeds);
    collectEvidence(evidence, 'tag', tagsByContact.get(contact.id) ?? [], tagTerms);

    if (queryTerms.length > 0) {
      const profileFields = [contact.company, contact.title, contact.how_we_met].filter(
        (value): value is string => value !== null && value !== '',
      );
      collectEvidence(evidence, 'profile', profileFields, queryTerms);
    }

    if (evidence.length === 0) {
      // Der Index kennt auch erledigte Needs/Offers. Wer nur darueber
      // hereingekommen ist, hat aktuell nichts Offenes anzubieten.
      continue;
    }

    candidates.push({ contact, matched_on: evidence.slice(0, MATCH_MAX_EVIDENCE) });
  }

  candidates.sort((a, b) => {
    const rankA = bestRank.get(a.contact.id) ?? Number.POSITIVE_INFINITY;
    const rankB = bestRank.get(b.contact.id) ?? Number.POSITIVE_INFINITY;
    if (rankA !== rankB) {
      return rankA - rankB;
    }
    return a.contact.name.localeCompare(b.contact.name);
  });

  return candidates.slice(0, limit);
}

function mergeTerms(a: readonly string[], b: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of [...a, ...b]) {
    if (term === '' || seen.has(term)) {
      continue;
    }
    seen.add(term);
    out.push(term);
  }
  return out;
}

/**
 * Traegt fuer jeden Text jeden treffenden Begriff als eigenen Beleg ein.
 *
 * Fuer Needs, Offers und Profilfelder trifft ein Begriff, wenn ein Wort des
 * Textes mit ihm beginnt - dieselbe Praefix-Logik, die auch die FTS-Suche
 * benutzt. Tags sind kontrolliertes Vokabular und laufen ueber tagMatchesTerm,
 * damit die Belege genau die Regel abbilden, nach der findContactsByTags die
 * Kandidaten ueberhaupt eingesammelt hat.
 */
function collectEvidence(
  target: MatchEvidence[],
  kind: MatchEvidence['kind'],
  texts: readonly string[],
  terms: readonly string[],
): void {
  if (terms.length === 0) {
    return;
  }
  for (const text of texts) {
    const normalized = normalizeText(text);
    const tokens = tokenize(text);
    if (tokens.length === 0) {
      continue;
    }
    for (const term of terms) {
      const hit =
        kind === 'tag'
          ? tagMatchesTerm(text, term)
          : normalized.startsWith(term) || tokens.some((token) => token.startsWith(term));
      if (hit) {
        target.push({ kind, text, term });
        if (target.length >= MATCH_MAX_EVIDENCE) {
          return;
        }
      }
    }
  }
}

/**
 * Kontakte, die einen der Tags tragen. Lange, aussagekraeftige Begriffe suchen
 * als Praefix, kurze und generische nur exakt - dieselbe Regel wie in
 * tagMatchesTerm, siehe die Begruendung bei isPrefixCapableTerm.
 */
function findContactsByTags(terms: readonly string[]): number[] {
  if (terms.length === 0) {
    return [];
  }

  const conditions: string[] = [];
  const params: string[] = [];
  for (const term of terms) {
    if (isPrefixCapableTerm(term)) {
      conditions.push("t.name LIKE ? ESCAPE '\\'");
      params.push(`${escapeLike(term)}%`);
    } else {
      conditions.push('t.name = ?');
      params.push(term);
    }
  }

  const rows = allRows<{ contact_id: number }>(
    'SELECT DISTINCT ct.contact_id AS contact_id FROM contact_tags ct ' +
      `JOIN tags t ON t.id = ct.tag_id WHERE ${conditions.join(' OR ')}`,
    params,
  );
  return rows.map((row) => row.contact_id);
}

/** Aus einer Kandidatenmenge nur die aktiven Kontakte laden. */
function loadActiveContacts(ids: readonly number[]): Contact[] {
  const out: Contact[] = [];
  for (const block of chunk(ids, ID_CHUNK_SIZE)) {
    out.push(
      ...allRows<Contact>(
        `SELECT ${CONTACT_SELECT_PLAIN} FROM contacts ` +
          `WHERE status = 'active' AND id IN (${placeholders(block.length)})`,
        block,
      ),
    );
  }
  return out;
}

/** Offene Needs bzw. Offers fuer viele Kontakte, gruppiert nach Kontakt. */
function loadOpenItems(table: ItemTable, ids: readonly number[]): Map<number, string[]> {
  const result = new Map<number, string[]>();
  for (const block of chunk(ids, ID_CHUNK_SIZE)) {
    const rows = allRows<{ contact_id: number; text: string }>(
      `SELECT contact_id, text FROM ${table} ` +
        `WHERE resolved_at IS NULL AND contact_id IN (${placeholders(block.length)}) ` +
        'ORDER BY created_at ASC, id ASC',
      block,
    );
    for (const row of rows) {
      const existing = result.get(row.contact_id);
      if (existing === undefined) {
        result.set(row.contact_id, [row.text]);
      } else {
        existing.push(row.text);
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Statistik
// ---------------------------------------------------------------------------

export function countContactsByStatus(): Record<ContactStatus, number> {
  const counts: Record<ContactStatus, number> = { imported: 0, active: 0, archived: 0 };
  const rows = allRows<{ status: ContactStatus; total: number }>(
    'SELECT status, COUNT(*) AS total FROM contacts GROUP BY status',
  );
  for (const row of rows) {
    counts[row.status] = row.total;
  }
  return counts;
}

export function countContactsByStage(): Record<Stage, number> {
  const counts: Record<Stage, number> = {
    new: 0,
    reached_out: 0,
    in_touch: 0,
    close: 0,
    dormant: 0,
  };
  const rows = allRows<{ stage: Stage; total: number }>(
    'SELECT stage, COUNT(*) AS total FROM contacts GROUP BY stage',
  );
  for (const row of rows) {
    counts[row.stage] = row.total;
  }
  return counts;
}

/**
 * Alle vorkommenden Staedte - fuer den Filter in der Listenansicht.
 * Gruppiert ueber norm_text, also ohne Ruecksicht auf Gross-/Kleinschreibung
 * UND ohne Ruecksicht auf diakritische Zeichen, weil der city-Filter genauso
 * vergleicht: "Berlin"/"berlin" und "München"/"MÜNCHEN" waeren sonst je zwei
 * Eintraege im Dropdown, die dasselbe filtern. COLLATE NOCASE reicht dafuer
 * nicht, es faltet nur ASCII A-Z. MIN() waehlt einen festen Vertreter.
 */
export function listDistinctCities(): string[] {
  const rows = allRows<{ city: string }>(
    "SELECT MIN(city) AS city FROM contacts WHERE city IS NOT NULL AND city <> '' " +
      'GROUP BY norm_text(city) ORDER BY norm_text(city) ASC',
  );
  return rows.map((row) => row.city);
}
