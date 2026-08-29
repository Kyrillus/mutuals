'use server';

/**
 * Die Server Actions von Mutuals - die einzige Stelle, an der die Oberflaeche
 * schreibt.
 *
 * Aufbau jeder Action, ohne Ausnahme:
 *   1. Eingaben mit zod pruefen. Ein Formular ist keine Validierung: die Werte
 *      kommen ueber die Leitung und koennen alles sein.
 *   2. Genau eine Funktion aus lib/queries.ts rufen. Kein SQL hier, keine
 *      Geschaeftsregel hier - die imported-zu-active-Regel etwa steht in
 *      updateContact und wird nicht nachgebaut.
 *   3. Ein ActionResult zurueckgeben. Nie werfen.
 *
 * Warum nie werfen: eine geworfene Ausnahme in einer Server Action landet in
 * Produktion als "An error occurred in the Server Components render" beim
 * Nutzer - ohne Text, ohne Feldbezug, ohne Moeglichkeit, die Eingabe zu
 * korrigieren. Ein Ergebnisobjekt kann die Ansicht neben dem Feld anzeigen.
 *
 * Alle Meldungen sind deutsch und beschreiben, was der Mensch tun kann. Ein
 * Stacktrace oder eine SQLite-Meldung geht nie nach draussen; sie landet auf
 * der Serverkonsole.
 */

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { CONTACT_STATUSES, ROLES, SOURCES, STAGES } from '@/lib/constants';
import type { ContactStatus, Stage } from '@/lib/constants';
import { columnMappingSchema, suggestMapping } from '@/lib/import/mapping';
import { parseBuffer } from '@/lib/import/parse';
import { importParsedFile } from '@/lib/import/run';
import type {
  ColumnMapping,
  ImportSummary,
  MappingSuggestion,
  RawRow,
} from '@/lib/import/types';
import {
  CONTACT_SORT_COLUMNS,
  NotFoundError,
  addNeed,
  addNote,
  addOffer,
  addTagToContact,
  createContact,
  deleteContact,
  deleteNeed,
  deleteNote,
  deleteOffer,
  findMatches,
  getContactDetail,
  listBoardContacts,
  listContacts,
  listDistinctCities,
  listTags,
  listTagsForContact,
  removeTagFromContact,
  resolveNeed,
  resolveOffer,
  searchTags,
  setStage,
  setStatus,
  unresolveNeed,
  unresolveOffer,
  updateContact,
  updateNeedText,
  updateOfferText,
} from '@/lib/queries';
import type {
  Contact,
  ContactDetail,
  ContactFilters,
  ContactListRow,
  ContactPatch,
  MatchCandidate,
  Need,
  NewContactInput,
  Note,
  Offer,
  Tag,
} from '@/lib/types';

// ---------------------------------------------------------------------------
// Ergebnisform
// ---------------------------------------------------------------------------

/**
 * Das einheitliche Ergebnis jeder Action. Die Oberflaeche prueft `ok` und hat
 * danach entweder Daten oder einen anzeigbaren Satz - nie beides, nie keines.
 */
export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Rueckgabe von importPreviewAction, siehe dort. */
export interface ImportPreview {
  headers: string[];
  rows: RawRow[];
  preambleLines: number;
  format: string;
  suggestion: MappingSuggestion;
  totalRows: number;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Fehlerbeschreibung
// ---------------------------------------------------------------------------

/** Feldnamen aus den Schemas in etwas, das man einem Menschen zeigen kann. */
const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  status: 'Status',
  stage: 'Phase',
  role: 'Rolle',
  company: 'Firma',
  title: 'Position',
  city: 'Stadt',
  country: 'Land',
  email: 'E-Mail',
  phone: 'Telefon',
  linkedin_url: 'LinkedIn-Profil',
  birthday: 'Geburtstag',
  how_we_met: 'Kennengelernt',
  closeness: 'Naehe',
  source: 'Quelle',
  last_contact_at: 'Letzter Kontakt',
  text: 'Text',
  body: 'Notiz',
  query: 'Suchbegriff',
  tag: 'Tag',
  column: 'Sortierspalte',
  direction: 'Sortierrichtung',
};

/**
 * Deutsche Entsprechung der zod-Fehlerarten.
 *
 * Bewusst NICHT issue.message der eingebauten Pruefungen: die ist englisch
 * ("Too small: expected string to have >=1 characters") und im Interface
 * unbrauchbar. Eigene Meldungen aus .refine() kommen dagegen als code
 * 'custom' an und werden woertlich durchgereicht - die sind hier und in
 * lib/queries.ts absichtlich deutsch formuliert.
 */
const ISSUE_TEXT: Record<string, string> = {
  invalid_type: 'hat den falschen Typ',
  too_small: 'ist leer oder zu kurz',
  too_big: 'ist zu lang',
  invalid_value: 'enthaelt einen unzulaessigen Wert',
  invalid_format: 'hat ein ungueltiges Format',
  invalid_union: 'hat ein ungueltiges Format',
  not_multiple_of: 'hat einen unzulaessigen Wert',
};

function describeZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) {
    return 'Die Eingabe ist ungueltig.';
  }
  if (issue.code === 'custom') {
    return issue.message;
  }

  const path = issue.path.map((part) => String(part)).join('.');
  const what = ISSUE_TEXT[issue.code] ?? 'ist ungueltig';
  if (path === '') {
    return `Die Eingabe ${what}.`;
  }
  return `Das Feld "${FIELD_LABELS[path] ?? path}" ${what}.`;
}

/**
 * Uebersetzt alles, was aus den unteren Schichten hochkommt, in einen Satz.
 *
 * Meldungen aus dem eigenen Code (NotFoundError, die Pruefungen in
 * lib/import/parse.ts) sind bereits deutsch und aussagekraeftig und gehen
 * woertlich durch. Alles, was nach Datenbank riecht, wird ersetzt - eine
 * SQLITE_CONSTRAINT-Meldung hilft niemandem und verraet den Aufbau.
 */
function describeError(error: unknown): string {
  console.error('[actions]', error);

  if (error instanceof z.ZodError) {
    return describeZodError(error);
  }
  if (error instanceof NotFoundError) {
    return error.message;
  }
  if (error instanceof Error) {
    const message = error.message.trim();
    if (message !== '' && !/sqlite/i.test(message) && !/\n/.test(message)) {
      return message;
    }
  }
  return 'Es ist ein unerwarteter Fehler aufgetreten. Bitte noch einmal versuchen.';
}

/** Nur lesen: kein revalidatePath. */
function read<T>(fn: () => T): ActionResult<T> {
  try {
    return { ok: true, data: fn() };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

/**
 * Schreiben: nach Erfolg werden die Server-Komponenten der betroffenen Seiten
 * verworfen, damit Liste und Board beim naechsten Rendern frische Daten sehen.
 */
function write<T>(fn: () => T): ActionResult<T> {
  try {
    const data = fn();
    revalidatePath('/');
    revalidatePath('/board');
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const idSchema = z.number().int().positive();
const stageSchema = z.enum(STAGES);
const statusSchema = z.enum(CONTACT_STATUSES);
const roleSchema = z.enum(ROLES);
const sourceSchema = z.enum(SOURCES);

/** Pflichttext. */
function requiredText(max: number, label: string) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => value.length > 0, `${label} darf nicht leer sein.`)
    .refine((value) => value.length <= max, `${label} ist zu lang (hoechstens ${max} Zeichen).`);
}

/**
 * Freiwilliges Textfeld eines Kontakts.
 *
 * null heisst "leeren", undefined heisst "nicht anfassen". Ein leerer String
 * aus einem Formular wird zu null gefaltet, damit beide Wege denselben
 * Zielzustand erzeugen und lib/queries.ts nicht zwei Faelle sieht.
 */
function optionalText(max: number) {
  return z
    .string()
    .max(max)
    .nullable()
    .optional()
    .transform((value) => {
      if (value === null || value === undefined) {
        return value;
      }
      const trimmed = value.trim();
      return trimmed === '' ? null : trimmed;
    });
}

const emailSchema = optionalText(320).refine(
  (value) => value === null || value === undefined || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value),
  'Die E-Mail-Adresse sieht nicht wie eine Adresse aus.',
);

const birthdaySchema = optionalText(20).refine(
  (value) =>
    value === null ||
    value === undefined ||
    /^(\d{4}-\d{2}-\d{2}|--\d{2}-\d{2})$/.test(value),
  'Der Geburtstag muss als JJJJ-MM-TT oder als --MM-TT (ohne Jahr) angegeben werden.',
);

const isoDateSchema = optionalText(40).refine(
  (value) => value === null || value === undefined || !Number.isNaN(Date.parse(value)),
  'Das Datum ist kein gueltiges Datum.',
);

const closenessSchema = z
  .number()
  .int()
  .min(1, 'Die Naehe liegt zwischen 1 und 5.')
  .max(5, 'Die Naehe liegt zwischen 1 und 5.')
  .nullable()
  .optional();

/** Die Felder, die Anlegen und Bearbeiten gemeinsam haben. */
const contactFields = {
  stage: stageSchema.optional(),
  role: roleSchema.nullable().optional(),
  company: optionalText(200),
  title: optionalText(200),
  city: optionalText(120),
  country: optionalText(120),
  email: emailSchema,
  phone: optionalText(60),
  linkedin_url: optionalText(500),
  birthday: birthdaySchema,
  how_we_met: optionalText(2000),
  closeness: closenessSchema,
  source: sourceSchema.optional(),
  last_contact_at: isoDateSchema,
} as const;

const newContactSchema = z.object({
  name: requiredText(200, 'Der Name'),
  ...contactFields,
});

const contactPatchSchema = z.object({
  name: requiredText(200, 'Der Name').optional(),
  status: statusSchema.optional(),
  ...contactFields,
});

/** Filterwert aus einem Formular: leer heisst "kein Filter", nicht "leerer Wert". */
function filterText(max: number) {
  return z
    .string()
    .max(max)
    .optional()
    .transform((value) => {
      const trimmed = (value ?? '').trim();
      return trimmed === '' ? undefined : trimmed;
    });
}

const contactFiltersSchema = z.object({
  status: statusSchema.optional(),
  stage: stageSchema.optional(),
  role: roleSchema.optional(),
  city: filterText(120),
  tag: filterText(80),
  hasOpenNeeds: z.boolean().optional(),
  // Nicht ablehnen, sondern kappen: die Suche laeuft an jedem Tastendruck, und
  // ein eingefuegter Absatz ist kein Bedienfehler. Dieselbe Entscheidung wie
  // in lib/queries.ts.
  query: z
    .string()
    .optional()
    .transform((value) => {
      const trimmed = (value ?? '').trim();
      return trimmed === '' ? undefined : trimmed.slice(0, 500);
    }),
});

const sortSchema = z.object({
  column: z.enum(CONTACT_SORT_COLUMNS),
  direction: z.enum(['asc', 'desc']),
});

const tagNameSchema = requiredText(80, 'Der Tag');
const itemTextSchema = requiredText(2000, 'Der Text');
const noteBodySchema = requiredText(2000, 'Die Notiz');
const occurredOnSchema = z
  .string()
  .trim()
  .refine(
    (value) => /^\d{4}-\d{2}-\d{2}$/.test(value),
    'Das Datum muss als JJJJ-MM-TT angegeben werden.',
  )
  .optional();

const matchParamsSchema = z
  .object({
    contactId: idSchema.optional(),
    query: z
      .string()
      .max(500)
      .optional()
      .transform((value) => {
        const trimmed = (value ?? '').trim();
        return trimmed === '' ? undefined : trimmed;
      }),
  })
  .refine(
    (value) => value.contactId !== undefined || value.query !== undefined,
    'Fuer die Suche nach Matches braucht es einen Kontakt oder einen Suchbegriff.',
  );

// ---------------------------------------------------------------------------
// Kontakte
// ---------------------------------------------------------------------------

export async function listContactsAction(
  filters: ContactFilters,
  sort?: { column: string; direction: 'asc' | 'desc' },
): Promise<ActionResult<ContactListRow[]>> {
  return read(() => {
    const parsedFilters = contactFiltersSchema.parse(filters ?? {});
    const parsedSort = sort === undefined ? undefined : sortSchema.parse(sort);
    return listContacts(parsedFilters, parsedSort);
  });
}

/** Detailansicht inklusive Notizen - die Oberflaeche zeigt sie alle. */
export async function getContactDetailAction(id: number): Promise<ActionResult<ContactDetail>> {
  return read(() => {
    const contactId = idSchema.parse(id);
    const detail = getContactDetail(contactId, { includeNotes: true });
    if (detail === null) {
      throw new NotFoundError('Kontakt', contactId);
    }
    return detail;
  });
}

/** Neu angelegte Kontakte sind immer aktiv - deshalb ist status kein Eingabefeld. */
export async function createContactAction(
  input: NewContactInput,
): Promise<ActionResult<Contact>> {
  return write(() => {
    const parsed = newContactSchema.parse(input);
    return createContact({ ...parsed, status: 'active' });
  });
}

export async function updateContactAction(
  id: number,
  patch: ContactPatch,
): Promise<ActionResult<Contact>> {
  return write(() => {
    const contactId = idSchema.parse(id);
    const parsed = contactPatchSchema.parse(patch);
    return updateContact(contactId, parsed);
  });
}

export async function setStageAction(id: number, stage: Stage): Promise<ActionResult<Contact>> {
  return write(() => setStage(idSchema.parse(id), stageSchema.parse(stage)));
}

export async function setStatusAction(
  id: number,
  status: ContactStatus,
): Promise<ActionResult<Contact>> {
  return write(() => setStatus(idSchema.parse(id), statusSchema.parse(status)));
}

export async function deleteContactAction(id: number): Promise<ActionResult<null>> {
  return write(() => {
    deleteContact(idSchema.parse(id));
    return null;
  });
}

// ---------------------------------------------------------------------------
// Needs und Offers
// ---------------------------------------------------------------------------

export async function addNeedAction(contactId: number, text: string): Promise<ActionResult<Need>> {
  return write(() => addNeed(idSchema.parse(contactId), itemTextSchema.parse(text)));
}

export async function addOfferAction(
  contactId: number,
  text: string,
): Promise<ActionResult<Offer>> {
  return write(() => addOffer(idSchema.parse(contactId), itemTextSchema.parse(text)));
}

export async function toggleNeedResolvedAction(
  id: number,
  resolved: boolean,
): Promise<ActionResult<Need>> {
  return write(() => {
    const needId = idSchema.parse(id);
    return z.boolean().parse(resolved) ? resolveNeed(needId) : unresolveNeed(needId);
  });
}

export async function toggleOfferResolvedAction(
  id: number,
  resolved: boolean,
): Promise<ActionResult<Offer>> {
  return write(() => {
    const offerId = idSchema.parse(id);
    return z.boolean().parse(resolved) ? resolveOffer(offerId) : unresolveOffer(offerId);
  });
}

export async function updateNeedTextAction(
  id: number,
  text: string,
): Promise<ActionResult<Need>> {
  return write(() => updateNeedText(idSchema.parse(id), itemTextSchema.parse(text)));
}

export async function updateOfferTextAction(
  id: number,
  text: string,
): Promise<ActionResult<Offer>> {
  return write(() => updateOfferText(idSchema.parse(id), itemTextSchema.parse(text)));
}

export async function deleteNeedAction(id: number): Promise<ActionResult<null>> {
  return write(() => {
    deleteNeed(idSchema.parse(id));
    return null;
  });
}

export async function deleteOfferAction(id: number): Promise<ActionResult<null>> {
  return write(() => {
    deleteOffer(idSchema.parse(id));
    return null;
  });
}

// ---------------------------------------------------------------------------
// Notizen
// ---------------------------------------------------------------------------

/**
 * Notiz anlegen. Ohne Datum gilt heute; lib/queries.ts zieht ausserdem
 * last_contact_at nach - das gehoert dorthin und wird hier nicht wiederholt.
 */
export async function addNoteAction(
  contactId: number,
  body: string,
  occurredOn?: string,
): Promise<ActionResult<Note>> {
  return write(() => {
    const id = idSchema.parse(contactId);
    const text = noteBodySchema.parse(body);
    const date = occurredOnSchema.parse(occurredOn);
    return date === undefined ? addNote(id, text) : addNote(id, text, date);
  });
}

export async function deleteNoteAction(id: number): Promise<ActionResult<null>> {
  return write(() => {
    deleteNote(idSchema.parse(id));
    return null;
  });
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/**
 * Tags geben immer die vollstaendige, neue Tagliste des Kontakts zurueck.
 * Die Ansicht ersetzt damit ihren Zustand, statt ihn fortzuschreiben - sonst
 * laufen zwei schnell hintereinander geklickte Aenderungen auseinander.
 */
export async function addTagAction(
  contactId: number,
  tagName: string,
): Promise<ActionResult<Tag[]>> {
  return write(() => {
    const id = idSchema.parse(contactId);
    addTagToContact(id, tagNameSchema.parse(tagName));
    return listTagsForContact(id);
  });
}

export async function removeTagAction(
  contactId: number,
  tagId: number,
): Promise<ActionResult<Tag[]>> {
  return write(() => {
    const id = idSchema.parse(contactId);
    removeTagFromContact(id, idSchema.parse(tagId));
    return listTagsForContact(id);
  });
}

/** Autovervollstaendigung. Leerer Praefix liefert alle Tags. */
export async function searchTagsAction(prefix: string): Promise<ActionResult<Tag[]>> {
  return read(() => searchTags(z.string().max(80).parse(prefix ?? '')));
}

// ---------------------------------------------------------------------------
// Board, Filter, Matching
// ---------------------------------------------------------------------------

export async function listBoardAction(): Promise<ActionResult<Record<Stage, ContactListRow[]>>> {
  return read(() => listBoardContacts());
}

/** Die Werte, mit denen sich die Liste filtern laesst. */
export async function listFilterOptionsAction(): Promise<
  ActionResult<{ cities: string[]; tags: Tag[] }>
> {
  return read(() => ({ cities: listDistinctCities(), tags: listTags() }));
}

export async function findMatchesAction(params: {
  contactId?: number;
  query?: string;
}): Promise<ActionResult<MatchCandidate[]>> {
  return read(() => {
    const parsed = matchParamsSchema.parse(params ?? {});
    return findMatches(parsed);
  });
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/** 20 MB. Der groesste je gesehene LinkedIn-Export liegt bei unter einem MB. */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Dieselben Endungen, die lib/import/parse.ts kennt. */
const ALLOWED_EXTENSIONS = ['.csv', '.xlsx', '.xls'] as const;

/** Hoechstens so viele Datenzeilen gehen in die Vorschau. */
const PREVIEW_ROWS = 10;

/**
 * Holt die Datei aus dem FormData und prueft sie, BEVOR ein Parser sie sieht.
 *
 * Groesse und Endung werden hier geprueft und nicht erst im Parser: eine
 * 400-MB-Datei soll gar nicht erst in den Speicher gelesen werden, und die
 * Fehlermeldung soll von der Datei sprechen, nicht vom Format.
 */
async function readUpload(formData: FormData): Promise<{ buffer: Buffer; filename: string }> {
  const entry = formData.get('file');
  if (!(entry instanceof File)) {
    throw new Error('Es wurde keine Datei uebermittelt.');
  }
  if (entry.size === 0) {
    throw new Error('Die Datei ist leer.');
  }
  if (entry.size > MAX_UPLOAD_BYTES) {
    throw new Error('Die Datei ist groesser als 20 MB und wird nicht eingelesen.');
  }

  const filename = entry.name.trim() === '' ? 'upload.csv' : entry.name.trim();
  const dot = filename.lastIndexOf('.');
  const extension = dot === -1 ? '' : filename.slice(dot).toLowerCase();
  if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(extension)) {
    throw new Error(
      `Dateien mit der Endung "${extension || filename}" koennen nicht gelesen werden. ` +
        'Moeglich sind .csv, .xlsx und .xls.',
    );
  }

  return { buffer: Buffer.from(await entry.arrayBuffer()), filename };
}

/**
 * Vorschau auf einen Import. Schreibt NICHTS.
 *
 * Zurueck kommen die Kopfzeile, hoechstens zehn Datenzeilen, der
 * Zuordnungsvorschlag und die Warnungen des Parsers (falsche Endung, geratene
 * Kodierung). Die Warnungen sind der Grund, warum die Vorschau ueberhaupt
 * existiert: sie entscheiden darueber, ob die Datei ueberhaupt die richtige
 * ist, und das kann nur ein Mensch.
 *
 * Die Zeilen und die Zuordnung werden vor der Rueckgabe in gewoehnliche
 * Objekte kopiert. parse.ts und mapping.ts bauen sie ohne Prototyp
 * (Object.create(null)), was fuer die Serialisierung zum Browser unnoetig
 * dicht am Rand des Erlaubten liegt.
 */
export async function importPreviewAction(
  formData: FormData,
): Promise<ActionResult<ImportPreview>> {
  try {
    const { buffer, filename } = await readUpload(formData);
    const parsed = parseBuffer(buffer, filename);
    const suggestion = suggestMapping([...parsed.headers]);

    return {
      ok: true,
      data: {
        headers: [...parsed.headers],
        rows: parsed.rows.slice(0, PREVIEW_ROWS).map((row) => ({ ...row })),
        preambleLines: parsed.preambleLines,
        format: parsed.format,
        suggestion: { ...suggestion, mapping: { ...suggestion.mapping } },
        totalRows: parsed.rows.length,
        warnings: [...(parsed.warnings ?? [])],
      },
    };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

/**
 * Fuehrt den Import aus.
 *
 * Die Datei wird erneut mitgeschickt und erneut geparst, statt die Vorschau
 * zwischenzuspeichern. Das ist Absicht: ein Zwischenspeicher waere Zustand
 * zwischen zwei Anfragen, der ablaufen, verloren gehen oder zur falschen
 * Datei gehoeren kann. Ein zweiter Parserlauf ueber ein paar hundert
 * Kilobyte kostet nichts.
 *
 * dryRun reicht den Trockenlauf aus lib/import/run.ts durch: derselbe Lauf,
 * dieselbe Transaktion, am Ende ein Rollback. Die Bilanz kommt vollstaendig
 * zurueck, geschrieben wird nichts - deshalb entfaellt dann auch das
 * revalidatePath, es gaebe nichts neu zu rendern.
 */
export async function importCommitAction(
  formData: FormData,
  mapping: ColumnMapping,
  source: string,
  dryRun: boolean = false,
): Promise<ActionResult<ImportSummary>> {
  try {
    const parsedMapping = columnMappingSchema.parse(mapping);
    const parsedSource = sourceSchema.parse(source);
    const parsedDryRun = z.boolean().parse(dryRun);
    const { buffer, filename } = await readUpload(formData);
    const parsed = parseBuffer(buffer, filename);

    const summary = importParsedFile(parsed, {
      mapping: parsedMapping,
      source: parsedSource,
      dryRun: parsedDryRun,
    });

    if (parsedDryRun) {
      return { ok: true, data: summary };
    }

    revalidatePath('/');
    revalidatePath('/board');
    return { ok: true, data: summary };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}
