/**
 * MCP-Server von Mutuals (stdio-Transport).
 *
 * Der Server ist eine duenne Huelle um lib/queries.ts. Er enthaelt keine
 * Fachlogik und kein SQL: er nimmt Werkzeugaufrufe entgegen, validiert die
 * Eingaben mit zod, ruft genau eine Query-Funktion auf und formt deren
 * Ergebnis in eine kompakte, fuer ein Sprachmodell lesbare Antwort um.
 *
 * DATENSCHUTZ - die Regel, an der sich jede Aenderung messen lassen muss:
 * Notizen sind die private Schicht dieses CRMs, persoenliche Gespraechsnotizen
 * ueber echte Menschen. Sie verlassen den Server auf genau einem Weg:
 * get_contact mit ausdruecklichem include_notes === true. Kein anderes Werkzeug
 * gibt sie zurueck, auch nicht gekuerzt, auch nicht als Trefferkontext, auch
 * nicht als Beleg beim Matching, auch nicht in einer Fehlermeldung. Es gibt
 * bewusst kein Werkzeug, das Notizen durchsucht oder auflistet.
 *
 * STDOUT gehoert beim stdio-Transport dem Protokoll. Alles, was dort sonst
 * landet, zerstoert die Verbindung. Diagnose geht nach stderr, siehe
 * redirectConsoleToStderr().
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { CONTACT_STATUSES, ROLES, STAGES } from '../lib/constants';
import { DB_PATH, closeDb } from '../lib/db';
import {
  NotFoundError,
  addNeed,
  addNote,
  addOffer,
  countContactsByStatus,
  createContact,
  findMatches,
  getContactDetail,
  listContacts,
  resolveNeed,
  setStage,
  updateContact,
} from '../lib/queries';
import type {
  Contact,
  ContactDetail,
  ContactFilters,
  ContactListRow,
  ContactPatch,
  ContactItem,
  MatchCandidate,
} from '../lib/types';

// ---------------------------------------------------------------------------
// Prozess-Hygiene
// ---------------------------------------------------------------------------

/**
 * Leitet console.log/info/debug auf stderr um.
 *
 * Kein Aufruf in dieser Datei benutzt console.log - die Umleitung schuetzt
 * gegen fremden Code (eine Abhaengigkeit, ein spaeterer Zusatz hier), der
 * ahnungslos auf stdout schreibt und damit den JSON-RPC-Strom zerreisst.
 * console.warn und console.error schreiben in Node ohnehin nach stderr.
 */
function redirectConsoleToStderr(): void {
  const toStderr = (...args: unknown[]): void => {
    console.error(...args);
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
}

/** Kurze Diagnosezeile nach stderr. Enthaelt nie Kontaktdaten. */
function logDiagnostic(message: string): void {
  process.stderr.write(`[mutuals-mcp] ${message}\n`);
}

const PACKAGE_NAME = 'mutuals';

/**
 * Version aus der package.json des Projekts. Gesucht wird aufwaerts vom
 * Modulverzeichnis aus, damit der kompilierte Server aus mcp/dist heraus
 * dieselbe Datei findet wie die Anwendung.
 */
function readServerVersion(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      const raw = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>;
        if (record['name'] === PACKAGE_NAME && typeof record['version'] === 'string') {
          return record['version'];
        }
      }
    } catch {
      // Keine oder kaputte package.json in diesem Verzeichnis - weiter aufwaerts.
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return '0.0.0';
    }
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// Antwortformat
// ---------------------------------------------------------------------------

/** Wirft alle null/undefined-Felder raus - spart Tokens und liest sich besser. */
function compact(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== null && entry !== undefined) {
      result[key] = entry;
    }
  }
  return result;
}

function ok(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Uebersetzt eine geworfene Ausnahme in eine Fehlermeldung fuer das Modell.
 *
 * Bei einem ZodError werden nur Pfad und Meldung uebernommen, nie der
 * empfangene Wert: die Meldung soll sagen, was falsch war, und nicht Daten
 * zurueckspiegeln.
 */
function describeError(error: unknown): string {
  if (error instanceof NotFoundError) {
    return `Not found: ${error.message}`;
  }
  if (error instanceof z.ZodError) {
    const issues = error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return `Invalid input: ${issues}`;
  }
  if (error instanceof Error) {
    // Fehlendes Schema ist der haeufigste Einrichtungsfehler und sieht ohne
    // Hinweis genauso aus wie ein Tippfehler im Pfad - getDb() legt bei einem
    // nicht vorhandenen Pfad stillschweigend eine leere Datei an. In Claude
    // Desktop sieht der Nutzer nur diese eine Zeile, also muss sie den Weg
    // hinaus nennen und den Pfad, um den es geht.
    if (/no such table/i.test(error.message)) {
      return (
        `Failed: the database at ${DB_PATH} has no schema yet. ` +
        'Run "npm run db:migrate" in the project directory. ' +
        'If that path looks wrong, check MUTUALS_DB_PATH in claude_desktop_config.json - ' +
        'an unknown path is created as an empty database rather than reported as missing.'
      );
    }
    return `Failed: ${error.message}`;
  }
  return 'Failed: unknown error.';
}

/**
 * Klammer um jeden Werkzeugrumpf. Jeder Fehler wird zu einem Ergebnis mit
 * isError - der Server bleibt stehen, statt die Verbindung abzureissen.
 */
function guard(run: () => CallToolResult): CallToolResult {
  try {
    return run();
  } catch (error) {
    return fail(describeError(error));
  }
}

// ---------------------------------------------------------------------------
// Projektionen
//
// Jede dieser Funktionen baut eine Antwort aus einer Zeile der Query-Schicht.
// Sie sind die Stelle, an der entschieden wird, WAS den Server verlaesst -
// deshalb steht hier nirgends ein Zugriff auf Notizen ausser dem einen,
// ausdruecklich freigegebenen in contactDetailPayload().
// ---------------------------------------------------------------------------

/** Treffer der Suche: genau die sieben Felder aus der Vorgabe. */
function searchHitPayload(row: ContactListRow): Record<string, unknown> {
  return compact({
    id: row.id,
    name: row.name,
    role: row.role,
    company: row.company,
    city: row.city,
    stage: row.stage,
    open_needs_count: row.open_needs_count,
  });
}

/** Kandidat beim Matching und Rueckgabe der Schreibwerkzeuge. */
function contactCorePayload(contact: Contact): Record<string, unknown> {
  return compact({
    id: contact.id,
    name: contact.name,
    status: contact.status,
    stage: contact.stage,
    role: contact.role,
    company: contact.company,
    title: contact.title,
    city: contact.city,
    country: contact.country,
    email: contact.email,
    phone: contact.phone,
    linkedin_url: contact.linkedin_url,
    birthday: contact.birthday,
    how_we_met: contact.how_we_met,
    closeness: contact.closeness,
    source: contact.source,
    last_contact_at: contact.last_contact_at,
  });
}

function itemPayload(item: ContactItem): Record<string, unknown> {
  return compact({
    id: item.id,
    text: item.text,
    open: item.resolved_at === null,
    resolved_at: item.resolved_at,
  });
}

/**
 * Vollstaendiger Kontakt fuer get_contact.
 *
 * includeNotes ist der einzige Weg, auf dem Notizen den Server verlassen.
 * Die Bedingung ist doppelt: das Flag muss true sein UND getContactDetail muss
 * ueberhaupt Notizen geliefert haben (was es nur mit demselben Flag tut).
 */
function contactDetailPayload(
  detail: ContactDetail,
  includeNotes: boolean,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    ...contactCorePayload(detail),
    needs: detail.needs.map(itemPayload),
    offers: detail.offers.map(itemPayload),
    tags: detail.tags.map((tag) => tag.name),
  };

  if (includeNotes && detail.notes !== undefined) {
    payload['notes'] = detail.notes.map((note) =>
      compact({ id: note.id, occurred_on: note.occurred_on, body: note.body }),
    );
  }

  return payload;
}

function matchCandidatePayload(candidate: MatchCandidate): Record<string, unknown> {
  return {
    contact: compact({
      id: candidate.contact.id,
      name: candidate.contact.name,
      role: candidate.contact.role,
      company: candidate.contact.company,
      title: candidate.contact.title,
      city: candidate.contact.city,
      stage: candidate.contact.stage,
    }),
    matched_on: candidate.matched_on.map((evidence) => ({
      kind: evidence.kind,
      text: evidence.text,
      term: evidence.term,
    })),
  };
}

// ---------------------------------------------------------------------------
// Eingabeschemas
//
// Bewusst schlichte zod-Bausteine ohne transform/refine: aus diesen Schemas
// erzeugt das SDK das JSON-Schema fuer tools/list. Die feinere Pruefung
// (Trimmen, Laengen, Normalisierung von LinkedIn-URLs, Datumsformate) macht
// ohnehin lib/queries.ts, und deren ZodError landet ueber guard() als klare
// Fehlermeldung im Ergebnis.
// ---------------------------------------------------------------------------

const contactIdSchema = z
  .number()
  .int()
  .positive()
  .describe('Internal contact id, as returned by search_contacts or find_matches.');

const stageSchema = z.enum(STAGES);
const statusSchema = z.enum(CONTACT_STATUSES);
const roleSchema = z.enum(ROLES);

/** Die schreibbaren Profilfelder. create_contact und update_contact teilen sie sich. */
const contactFieldShape = {
  role: roleSchema.describe('Rough category of the person.'),
  company: z.string().max(200).describe('Current employer or own company.'),
  title: z.string().max(200).describe('Free-text job title, e.g. "Head of Engineering".'),
  city: z.string().max(120).describe('City the person is based in.'),
  country: z.string().max(120).describe('Country the person is based in.'),
  email: z.string().max(320).describe('Email address.'),
  phone: z.string().max(60).describe('Phone number.'),
  linkedin_url: z.string().max(500).describe('LinkedIn profile URL.'),
  birthday: z.string().describe('Birthday as YYYY-MM-DD, or --MM-DD when the year is unknown.'),
  how_we_met: z.string().max(2000).describe('Short note on how the user met this person.'),
  closeness: z.number().int().min(1).max(5).describe('How close the user is: 1 loose, 5 close.'),
} as const;

/** Alle Profilfelder optional - fuer create_contact. */
const createContactShape = {
  name: z.string().min(1).max(200).describe('Full name. The only required field.'),
  stage: stageSchema.optional().describe('Pipeline stage. Defaults to "new".'),
  role: contactFieldShape.role.optional(),
  company: contactFieldShape.company.optional(),
  title: contactFieldShape.title.optional(),
  city: contactFieldShape.city.optional(),
  country: contactFieldShape.country.optional(),
  email: contactFieldShape.email.optional(),
  phone: contactFieldShape.phone.optional(),
  linkedin_url: contactFieldShape.linkedin_url.optional(),
  birthday: contactFieldShape.birthday.optional(),
  how_we_met: contactFieldShape.how_we_met.optional(),
  closeness: contactFieldShape.closeness.optional(),
} as const;

/** Wie createContactShape, aber jedes Feld darf null sein: null leert es. */
const updateContactShape = {
  contact_id: contactIdSchema,
  name: z.string().min(1).max(200).optional().describe('Full name.'),
  status: statusSchema
    .optional()
    .describe('"active" for people the user actually works with, "archived" to hide them.'),
  stage: stageSchema.optional().describe('Pipeline stage. Prefer set_stage for this alone.'),
  role: contactFieldShape.role.nullable().optional(),
  company: contactFieldShape.company.nullable().optional(),
  title: contactFieldShape.title.nullable().optional(),
  city: contactFieldShape.city.nullable().optional(),
  country: contactFieldShape.country.nullable().optional(),
  email: contactFieldShape.email.nullable().optional(),
  phone: contactFieldShape.phone.nullable().optional(),
  linkedin_url: contactFieldShape.linkedin_url.nullable().optional(),
  birthday: contactFieldShape.birthday.nullable().optional(),
  how_we_met: contactFieldShape.how_we_met.nullable().optional(),
  closeness: contactFieldShape.closeness.nullable().optional(),
} as const;

const SEARCH_LIMIT_DEFAULT = 20;
const SEARCH_LIMIT_MAX = 50;

// ---------------------------------------------------------------------------
// Werkzeuge
// ---------------------------------------------------------------------------

const IDS_ARE_INTERNAL =
  'The numeric ids in the result are for follow-up tool calls only - never read them out to the user.';

const NO_NOTES =
  'This tool never returns the private conversation notes stored for a person, and the full-text index it searches does not contain them.';

function registerTools(server: McpServer): void {
  // -- 1 -------------------------------------------------------------------
  server.registerTool(
    'search_contacts',
    {
      title: 'Search contacts',
      description:
        'Find people in the user\'s personal network by keyword and/or structured filters. This is the normal first step for almost every request about a person, because it returns the internal id that get_contact, add_note, add_need, add_offer, set_stage, update_contact and find_matches all need. The full-text search covers name, company, job title, how-we-met and the wording of the needs and offers recorded for a person. Results are compact by design - name, role, company, city, stage, number of open needs and the id - so use get_contact when you need the full record. Archived people are hidden unless you pass status explicitly. USE THIS, NOT find_matches, whenever the goal is to look someone up, list people matching a criterion, or get an id. find_matches answers a different question - who should be introduced to whom - and deliberately returns only a handful of active people with overlap evidence. ' +
        NO_NOTES +
        ' ' +
        IDS_ARE_INTERNAL,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        query: z
          .string()
          .max(500)
          .optional()
          .describe(
            'Free-text search. Words are matched as prefixes and combined with AND, so fewer, more distinctive words find more.',
          ),
        status: statusSchema
          .optional()
          .describe(
            '"imported" people came from a LinkedIn import and were never curated, "active" are the curated ones, "archived" are hidden by default.',
          ),
        stage: stageSchema.optional().describe('Restrict to one pipeline stage.'),
        role: roleSchema.optional().describe('Restrict to one role category.'),
        city: z.string().max(120).optional().describe('Exact city, case- and accent-insensitive.'),
        tag: z.string().max(80).optional().describe('Exact tag name.'),
        has_open_needs: z
          .boolean()
          .optional()
          .describe('true returns only people with at least one unresolved need.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(SEARCH_LIMIT_MAX)
          .optional()
          .describe(`Maximum number of hits, 1 to ${SEARCH_LIMIT_MAX}. Defaults to ${SEARCH_LIMIT_DEFAULT}.`),
      },
    },
    (args): CallToolResult =>
      guard(() => {
        const filters: ContactFilters = {};
        if (args.query !== undefined) {
          filters.query = args.query;
        }
        if (args.status !== undefined) {
          filters.status = args.status;
        }
        if (args.stage !== undefined) {
          filters.stage = args.stage;
        }
        if (args.role !== undefined) {
          filters.role = args.role;
        }
        if (args.city !== undefined) {
          filters.city = args.city;
        }
        if (args.tag !== undefined) {
          filters.tag = args.tag;
        }
        if (args.has_open_needs !== undefined) {
          filters.hasOpenNeeds = args.has_open_needs;
        }

        const limit = args.limit ?? SEARCH_LIMIT_DEFAULT;
        const rows = listContacts(filters);
        const shown = rows.slice(0, limit);

        return ok({
          total_matches: rows.length,
          returned: shown.length,
          truncated: rows.length > shown.length,
          contacts: shown.map(searchHitPayload),
        });
      }),
  );

  // -- 2 -------------------------------------------------------------------
  server.registerTool(
    'get_contact',
    {
      title: 'Get one contact',
      description:
        'Load one person in full: profile fields, all of their needs and offers (open and resolved) with the ids needed to resolve them, and their tags. Use it after search_contacts whenever the compact hit is not enough - before drafting an introduction, before updating a field, or when the user asks what someone is working on. PRIVACY: include_notes defaults to false and releases the private conversation notes the user has written about this person. Set it to true ONLY when the user has explicitly asked to see their notes about this person. Do not set it because more context might be helpful, and do not set it as a matter of routine - these are personal notes about a real human being. A missing include_notes means false. ' +
        IDS_ARE_INTERNAL,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        contact_id: contactIdSchema,
        include_notes: z
          .boolean()
          .optional()
          .describe(
            'Defaults to false. Set to true only on the explicit request of the user, to release their private conversation notes about this person.',
          ),
      },
    },
    (args): CallToolResult =>
      guard(() => {
        // Ausdruecklich === true: alles andere (fehlend, null, "false") ist false.
        const includeNotes = args.include_notes === true;
        const detail = getContactDetail(args.contact_id, { includeNotes });
        if (detail === null) {
          return fail(`Not found: no contact with id ${args.contact_id}.`);
        }
        return ok(contactDetailPayload(detail, includeNotes));
      }),
  );

  // -- 3 -------------------------------------------------------------------
  server.registerTool(
    'create_contact',
    {
      title: 'Create contact',
      description:
        'Add a new person to the network. Only name is required; everything else can be filled in later with update_contact. Search first with search_contacts - the database already holds an imported LinkedIn network, so the person may well be there under a slightly different spelling, and a duplicate is worse than a missing field. New contacts start as "active" in stage "new".',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: createContactShape,
    },
    (args): CallToolResult =>
      guard(() => {
        const contact = createContact({
          name: args.name,
          ...(args.stage !== undefined ? { stage: args.stage } : {}),
          ...(args.role !== undefined ? { role: args.role } : {}),
          ...(args.company !== undefined ? { company: args.company } : {}),
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.city !== undefined ? { city: args.city } : {}),
          ...(args.country !== undefined ? { country: args.country } : {}),
          ...(args.email !== undefined ? { email: args.email } : {}),
          ...(args.phone !== undefined ? { phone: args.phone } : {}),
          ...(args.linkedin_url !== undefined ? { linkedin_url: args.linkedin_url } : {}),
          ...(args.birthday !== undefined ? { birthday: args.birthday } : {}),
          ...(args.how_we_met !== undefined ? { how_we_met: args.how_we_met } : {}),
          ...(args.closeness !== undefined ? { closeness: args.closeness } : {}),
        });
        return ok({ created: true, contact: contactCorePayload(contact) });
      }),
  );

  // -- 4 -------------------------------------------------------------------
  server.registerTool(
    'update_contact',
    {
      title: 'Update contact',
      description:
        'Change fields on an existing person. Only the fields you pass are touched; pass null to clear a field. Use it when the user mentions something new or corrects something - a new employer, a move to another city, a corrected email. Editing a person who came from the LinkedIn import promotes them from "imported" to "active", which is intended: editing means the user has adopted the record. To change only the pipeline stage, prefer set_stage.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: updateContactShape,
    },
    (args): CallToolResult =>
      guard(() => {
        const patch: ContactPatch = {};
        if (args.name !== undefined) {
          patch.name = args.name;
        }
        if (args.status !== undefined) {
          patch.status = args.status;
        }
        if (args.stage !== undefined) {
          patch.stage = args.stage;
        }
        if (args.role !== undefined) {
          patch.role = args.role;
        }
        if (args.company !== undefined) {
          patch.company = args.company;
        }
        if (args.title !== undefined) {
          patch.title = args.title;
        }
        if (args.city !== undefined) {
          patch.city = args.city;
        }
        if (args.country !== undefined) {
          patch.country = args.country;
        }
        if (args.email !== undefined) {
          patch.email = args.email;
        }
        if (args.phone !== undefined) {
          patch.phone = args.phone;
        }
        if (args.linkedin_url !== undefined) {
          patch.linkedin_url = args.linkedin_url;
        }
        if (args.birthday !== undefined) {
          patch.birthday = args.birthday;
        }
        if (args.how_we_met !== undefined) {
          patch.how_we_met = args.how_we_met;
        }
        if (args.closeness !== undefined) {
          patch.closeness = args.closeness;
        }

        if (Object.keys(patch).length === 0) {
          return fail('Invalid input: pass at least one field to change besides contact_id.');
        }

        const contact = updateContact(args.contact_id, patch);
        return ok({ updated: true, contact: contactCorePayload(contact) });
      }),
  );

  // -- 5 -------------------------------------------------------------------
  server.registerTool(
    'add_note',
    {
      title: 'Add note',
      description:
        'Attach a private conversation note to a person - what was discussed, what they said, what to remember. Also moves the person\'s "last contact" date forward to the note\'s date. Use it when the user recounts a conversation, a meeting or a call. PRIVACY: notes are the private layer of this CRM. They can be written here, but they are never returned by search_contacts or find_matches; only get_contact with an explicit include_notes reads them back. The note body is not echoed in the result.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        contact_id: contactIdSchema,
        body: z.string().min(1).max(2000).describe('The note itself, in the user\'s own words.'),
        occurred_on: z
          .string()
          .optional()
          .describe(
            'Date of the conversation as YYYY-MM-DD - the day it happened, not the day it is recorded. Defaults to today.',
          ),
      },
    },
    (args): CallToolResult =>
      guard(() => {
        const note = addNote(args.contact_id, args.body, args.occurred_on);
        // Bewusst ohne body: der Text muss nicht zurueckfliessen.
        //
        // Und bewusst ohne id: notes.id ist ein ueber alle Kontakte hinweg
        // steigender Zaehler. Wer eine einzige Notiz schreibt, erfuehre daraus
        // die ungefaehre Gesamtzahl aller Notizen in der Datenbank - der
        // einzige Mengen-Seitenkanal im ganzen Werkzeugsatz. Abnehmer hat die
        // id keinen: kein Werkzeug nimmt eine note_id entgegen. Kaeme spaeter
        // ein delete_note dazu, brachte es die id mit sich.
        return ok({
          created: true,
          note: compact({
            contact_id: note.contact_id,
            occurred_on: note.occurred_on,
          }),
        });
      }),
  );

  // -- 6 -------------------------------------------------------------------
  server.registerTool(
    'add_need',
    {
      title: 'Add need',
      description:
        'Record something a person is looking for: a hire, an introduction, funding, a customer, advice. Open needs are exactly what find_matches matches against other people\'s open offers, so write concrete, searchable wording ("Series A lead investor healthtech") rather than a full sentence ("She mentioned that she is currently trying to find someone"). One need per distinct thing they are looking for.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        contact_id: contactIdSchema,
        text: z.string().min(1).max(2000).describe('What the person is looking for.'),
      },
    },
    (args): CallToolResult =>
      guard(() => {
        const need = addNeed(args.contact_id, args.text);
        return ok({ created: true, need: itemPayload(need) });
      }),
  );

  // -- 7 -------------------------------------------------------------------
  server.registerTool(
    'add_offer',
    {
      title: 'Add offer',
      description:
        'Record something a person can provide: expertise, an introduction into a company or scene, capital, a service, a spare seat on a team. Open offers are matched against other people\'s open needs by find_matches, so use concrete, searchable wording and record one offer per distinct thing they can provide.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        contact_id: contactIdSchema,
        text: z.string().min(1).max(2000).describe('What the person can provide.'),
      },
    },
    (args): CallToolResult =>
      guard(() => {
        const offer = addOffer(args.contact_id, args.text);
        return ok({ created: true, offer: itemPayload(offer) });
      }),
  );

  // -- 8 -------------------------------------------------------------------
  server.registerTool(
    'resolve_need',
    {
      title: 'Resolve need',
      description:
        'Mark one need as fulfilled - the hire was made, the introduction happened, the round closed. The need is kept and stamped with a resolution date rather than deleted, so the history stays intact, but it stops counting as open and stops being matched by find_matches. Takes the need id from get_contact, not the contact id.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        need_id: z
          .number()
          .int()
          .positive()
          .describe('Id of the need itself, as listed under "needs" by get_contact.'),
      },
    },
    (args): CallToolResult =>
      guard(() => {
        const need = resolveNeed(args.need_id);
        return ok({ resolved: true, need: itemPayload(need) });
      }),
  );

  // -- 9 -------------------------------------------------------------------
  server.registerTool(
    'set_stage',
    {
      title: 'Set stage',
      description:
        'Move a person along the relationship pipeline. Stages are: "new" (not contacted yet), "reached_out" (message sent, no reply yet), "in_touch" (an exchange is running), "close" (a real relationship), "dormant" (has fallen asleep). Use it when the user reports a change in the relationship - they wrote to someone, met them, or lost touch. Moving a person who came from the LinkedIn import also promotes them to "active".',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        contact_id: contactIdSchema,
        stage: stageSchema.describe('The new pipeline stage.'),
      },
    },
    (args): CallToolResult =>
      guard(() => {
        const contact = setStage(args.contact_id, args.stage);
        return ok({ updated: true, contact: contactCorePayload(contact) });
      }),
  );

  // -- 10 ------------------------------------------------------------------
  server.registerTool(
    'find_matches',
    {
      title: 'Find matches',
      description:
        'The core tool of this CRM: find people worth introducing to each other. Give it either contact_id (start from a person - their open needs are matched against other people\'s open offers, and their open offers against other people\'s needs) or query (start from a free-text description of what is being looked for or offered). Returns at most ten candidates, all of them with status "active". Every candidate carries matched_on: the concrete needs, offers, tags or profile fields the overlap rests on, plus the search term that hit them. THESE ARE CANDIDATES, NOT RECOMMENDATIONS. There is deliberately no score and no confidence value, because the overlap is plain keyword and tag matching and a number would claim a certainty that does not exist. Read the evidence yourself, judge each candidate on it, and say plainly when an overlap is thin or coincidental. USE search_contacts INSTEAD when the user simply wants to find, look up or list people - this tool only considers active contacts, ignores names entirely, and drops anyone it cannot show concrete overlap evidence for, so it is the wrong tool for looking someone up. ' +
        NO_NOTES +
        ' ' +
        IDS_ARE_INTERNAL,
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        contact_id: contactIdSchema
          .optional()
          .describe('Start from this person. Either this or query is required.'),
        query: z
          .string()
          .max(500)
          .optional()
          .describe(
            'Start from a free-text description, e.g. "looking for a technical co-founder in Berlin". Either this or contact_id is required.',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe('Maximum number of candidates, 1 to 10. Defaults to 10.'),
      },
    },
    (args): CallToolResult =>
      guard(() => {
        if (args.contact_id === undefined && (args.query ?? '').trim() === '') {
          return fail('Invalid input: pass either contact_id or a non-empty query.');
        }

        const candidates = findMatches({
          ...(args.contact_id !== undefined ? { contactId: args.contact_id } : {}),
          ...(args.query !== undefined ? { query: args.query } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        });

        return ok({
          guidance:
            'Candidates only, no score and no ranking to trust. Judge each one on its matched_on evidence and tell the user honestly how thin a match is.',
          count: candidates.length,
          candidates: candidates.map(matchCandidatePayload),
        });
      }),
  );
}

// ---------------------------------------------------------------------------
// Start und Herunterfahren
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  redirectConsoleToStderr();

  const server = new McpServer({ name: 'mutuals', version: readServerVersion() });
  registerTools(server);

  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = (reason: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logDiagnostic(`Herunterfahren (${reason}).`);
    void server
      .close()
      .catch(() => undefined)
      .finally(() => {
        closeDb();
        process.exit(0);
      });
  };

  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  // Der Client hat die Leitung geschlossen - regulaeres Ende, kein Fehler.
  transport.onclose = (): void => {
    shutdown('Transport geschlossen');
  };

  await server.connect(transport);
  // stderr ist der Kanal, den Claude Desktop im Log zeigt. Pfad und
  // Schemazustand stehen deshalb schon beim Start dort - ohne sie ist ein
  // Tippfehler in MUTUALS_DB_PATH von einer vergessenen Migration nicht zu
  // unterscheiden, weil eine unbekannte Datei stillschweigend als leere
  // Datenbank angelegt wird.
  logDiagnostic(`Datenbank: ${DB_PATH}`);
  try {
    const contacts = countContactsByStatus();
    const total = Object.values(contacts).reduce((sum, value) => sum + value, 0);
    logDiagnostic(`Schema vorhanden, ${total} Kontakt(e).`);
  } catch {
    logDiagnostic(
      'WARNUNG: In dieser Datenbank fehlt das Schema. In der Projektwurzel ' +
        '"npm run db:migrate" ausfuehren. Stimmt der Pfad oben nicht, zeigt ' +
        'MUTUALS_DB_PATH ins Leere - eine unbekannte Datei wird als leere ' +
        'Datenbank angelegt, nicht als fehlend gemeldet.',
    );
  }
  logDiagnostic('Bereit auf stdio.');
}

main().catch((error: unknown) => {
  logDiagnostic(`Start fehlgeschlagen: ${describeError(error)}`);
  closeDb();
  process.exit(1);
});
