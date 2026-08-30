/**
 * Schritt 2 des Imports: welche Spalte der Quelldatei fuellt welches Feld?
 *
 * suggestMapping schaut sich nur die Kopfzeile an und schlaegt eine Zuordnung
 * vor. applyMapping wendet eine (vorgeschlagene oder vom Menschen bestaetigte)
 * Zuordnung auf eine Datenzeile an und macht daraus einen Teil-Kontakt.
 *
 * Die Trennung ist Absicht: der Vorschlag muss vor dem ersten Schreibzugriff
 * angezeigt und bestaetigt werden koennen (CLI heute, Upload-Dialog in
 * Meilenstein 3), und beide Wege benutzen danach dieselbe Anwendung.
 *
 * Was hier NICHT passiert: Dubletten suchen (dedupe.ts) und schreiben (run.ts).
 * Diese Datei ist frei von Datenbankzugriff.
 */

import { z } from 'zod';

import { normalizeText, stripControlCharacters } from '../text';
import { looksLikeEmail, normalizeEmail, parseConnectedOn } from './normalize';
import type {
  ColumnMapping,
  ContactField,
  DroppedValue,
  MappingSuggestion,
  MappingTarget,
  NewContactInput,
  RawRow,
} from './types';

// ---------------------------------------------------------------------------
// Kopfzeilen vergleichen
// ---------------------------------------------------------------------------

/**
 * Vergleichsform eines Spaltennamens: klein, ohne Diakritika, ohne alles, was
 * kein Buchstabe und keine Ziffer ist.
 *
 * Damit sind 'E-Mail', 'E-Mail-Adresse', 'e mail' und 'EMail' derselbe
 * Schluessel, und ein Export, der seine Spalten in Anfuehrungszeichen oder mit
 * Doppelpunkt schreibt, faellt nicht durch. Die Faltung ist dieselbe wie
 * ueberall sonst im Projekt (lib/text.ts), damit 'Straße' und 'Strasse' nicht
 * je nach Modul unterschiedlich behandelt werden.
 */
function headerKey(header: string): string {
  return normalizeText(stripControlCharacters(header)).replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Ziel einer Spalte in der Alias-Tabelle. 'first_name'/'last_name' sind keine
 * Kontaktfelder, sondern die beiden Haelften von name - deshalb stehen sie hier
 * neben den echten Feldern und werden erst in toTarget zu einem MappingTarget.
 */
type AliasTarget = ContactField | 'first_name' | 'last_name';

/**
 * Bekannte Spaltennamen, bereits in der Vergleichsform von headerKey.
 *
 * Die LinkedIn-Zuordnung ist vorgegeben und steht deshalb jeweils vorn:
 *   'First Name' + 'Last Name' -> name, 'URL' -> linkedin_url,
 *   'Email Address' -> email, 'Company' -> company, 'Position' -> title,
 *   'Connected On' -> created_at.
 * Der Rest sind gaengige Varianten aus deutschen und englischen Exporten.
 *
 * Bewusst NICHT enthalten: das nackte 'url'. In einer LinkedIn-Datei ist das
 * die Profil-URL, in jeder anderen Datei mit hoher Wahrscheinlichkeit eine
 * Firmen-Website - und ein Feld dafuer gibt es im Kontakt nicht. 'url' wird
 * deshalb nur zugeordnet, wenn das LinkedIn-Layout erkannt wurde (siehe
 * LINKEDIN_ONLY_ALIASES).
 */
const ALIASES: ReadonlyArray<readonly [AliasTarget, readonly string[]]> = [
  ['first_name', ['firstname', 'first', 'vorname', 'givenname', 'forename', 'prenom']],
  ['last_name', ['lastname', 'last', 'nachname', 'surname', 'familyname', 'familienname', 'zuname']],
  [
    'name',
    ['name', 'fullname', 'displayname', 'anzeigename', 'contactname', 'kontaktname', 'kontakt', 'person'],
  ],
  [
    'email',
    [
      'email',
      'emailaddress',
      'emailadresse',
      'mail',
      'mailadresse',
      'primaryemail',
      'workemail',
      'businessemail',
    ],
  ],
  [
    'linkedin_url',
    [
      'linkedin',
      'linkedinurl',
      'linkedinlink',
      'linkedinprofile',
      'linkedinprofil',
      'linkedinprofileurl',
      'profileurl',
      'profilurl',
      'profillink',
    ],
  ],
  [
    'company',
    [
      'company',
      'companyname',
      'firma',
      'firmenname',
      'unternehmen',
      'unternehmensname',
      'organisation',
      'organization',
      'arbeitgeber',
      'employer',
    ],
  ],
  [
    'title',
    [
      'position',
      'title',
      'titel',
      'jobtitle',
      'jobtitel',
      'jobbezeichnung',
      'berufsbezeichnung',
      'stellenbezeichnung',
      'funktion',
      'currentposition',
      'aktuelleposition',
    ],
  ],
  ['city', ['city', 'stadt', 'ort', 'wohnort', 'standort', 'location']],
  ['country', ['country', 'land', 'staat', 'nation', 'countryregion']],
  [
    'phone',
    ['phone', 'phonenumber', 'telephone', 'tel', 'telefon', 'telefonnummer', 'mobile', 'mobil', 'mobilephone', 'handy'],
  ],
  ['birthday', ['birthday', 'birthdate', 'dateofbirth', 'dob', 'geburtstag', 'geburtsdatum']],
  ['how_we_met', ['howwemet', 'kennengelernt', 'wiewirunskennen']],
  [
    'created_at',
    ['connectedon', 'connecteddate', 'verbundenam', 'verbundenseit', 'createdat', 'erstelltam', 'kontaktseit'],
  ],
];

/** Nur im erkannten LinkedIn-Layout gueltig, siehe Begruendung an ALIASES. */
const LINKEDIN_ONLY_ALIASES: ReadonlyArray<readonly [AliasTarget, readonly string[]]> = [
  ['linkedin_url', ['url']],
];

/**
 * Baut aus der Tabelle die Nachschlage-Map.
 *
 * Der Duplikat-Check ist kein Luxus: stuende derselbe Schluessel zweimal in der
 * Tabelle, waere die Zuordnung von der Reihenfolge der Zeilen abhaengig und
 * eine der beiden Regeln wuerde stillschweigend nie greifen. Das faellt hier
 * beim Laden des Moduls auf und nicht erst an einer Kundendatei.
 */
function buildLookup(
  ...tables: ReadonlyArray<ReadonlyArray<readonly [AliasTarget, readonly string[]]>>
): ReadonlyMap<string, AliasTarget> {
  const lookup = new Map<string, AliasTarget>();
  for (const table of tables) {
    for (const [target, keys] of table) {
      for (const key of keys) {
        const known = lookup.get(key);
        if (known !== undefined) {
          throw new Error(
            `Alias "${key}" ist doppelt vergeben (${known} und ${target}) - lib/import/mapping.ts.`,
          );
        }
        lookup.set(key, target);
      }
    }
  }
  return lookup;
}

const GENERIC_LOOKUP = buildLookup(ALIASES);
const LINKEDIN_LOOKUP = buildLookup(ALIASES, LINKEDIN_ONLY_ALIASES);

// ---------------------------------------------------------------------------
// LinkedIn erkennen
// ---------------------------------------------------------------------------

/** Die Kopfzeile eines LinkedIn-Verbindungsexports, in Vergleichsform. */
const LINKEDIN_HEADER_KEYS: readonly string[] = [
  'firstname',
  'lastname',
  'url',
  'emailaddress',
  'company',
  'position',
  'connectedon',
];

/**
 * Wie viele der sieben LinkedIn-Spalten mindestens vorhanden sein muessen.
 *
 * Nicht alle sieben, weil ein in Excel nachbearbeiteter Export gern eine Spalte
 * verliert; nicht weniger, weil 'First Name'/'Last Name'/'Company' allein in
 * jedem zweiten CRM-Export stehen und dort 'URL' eben keine LinkedIn-URL ist.
 */
const LINKEDIN_MIN_MATCHES = 5;

function detectLinkedin(keys: readonly string[]): boolean {
  const present = new Set(keys);
  if (!present.has('firstname') || !present.has('lastname')) {
    return false;
  }
  const matches = LINKEDIN_HEADER_KEYS.filter((key) => present.has(key)).length;
  return matches >= LINKEDIN_MIN_MATCHES;
}

// ---------------------------------------------------------------------------
// suggestMapping
// ---------------------------------------------------------------------------

function toTarget(alias: AliasTarget): MappingTarget {
  if (alias === 'first_name') {
    return { kind: 'name_part', part: 'first' };
  }
  if (alias === 'last_name') {
    return { kind: 'name_part', part: 'last' };
  }
  return { kind: 'field', field: alias };
}

/**
 * Schlaegt anhand der Kopfzeile eine Zuordnung vor.
 *
 * Zwei Regeln, die im Vorschlag stecken:
 *
 *   - Ein Ziel wird nur EINMAL vergeben. Hat eine Datei 'E-Mail' und 'Mail',
 *     bekommt die erste Spalte das Feld und die zweite landet in unmapped.
 *     Sonst haengt es von der Spaltenreihenfolge ab, welcher Wert gewinnt, und
 *     der Nutzer sieht nie, dass es zwei Kandidaten gab.
 *   - Alles ohne Ziel bekommt ausdruecklich { kind: 'ignore' } und steht
 *     zusaetzlich in unmapped. Die Zuordnung ist damit vollstaendig: jeder
 *     Header der Datei kommt darin vor, auch der, der nicht importiert wird.
 *
 * confident heisst "das kann ohne Rueckfrage laufen" und verlangt beides:
 * ein sicher erkanntes Namensfeld (ohne Namen kann keine Zeile importiert
 * werden) und keine einzige offene Spalte. Die zweite Bedingung ist streng
 * ausgelegt - jede nicht zugeordnete Spalte ist eine Spalte, deren Daten
 * stillschweigend verloren gingen, und genau darueber soll der Mensch
 * entscheiden. Der Preis dafuer ist eine Rueckfrage; abschalten laesst sie sich
 * mit --yes.
 */
export function suggestMapping(headers: string[]): MappingSuggestion {
  const detectedSource: MappingSuggestion['detectedSource'] = detectLinkedin(headers.map(headerKey))
    ? 'linkedin'
    : 'unknown';
  const lookup = detectedSource === 'linkedin' ? LINKEDIN_LOOKUP : GENERIC_LOOKUP;

  // Object.create(null) und nicht {}: heisst eine Spalte '__proto__', traefe
  // die Zuweisung sonst den Prototype-Setter statt eine eigene Property. Der
  // Eintrag waere danach spurlos weg (und der Prototyp dieses Objekts wuerde
  // durch das MappingTarget ersetzt). Siehe dieselbe Begruendung an RawRow in
  // parse.ts.
  const mapping: ColumnMapping = Object.create(null) as ColumnMapping;
  const unmapped: string[] = [];
  const taken = new Set<AliasTarget>();

  for (const header of headers) {
    // Doppelte Headernamen kann es nach parse.ts nicht geben (dort werden sie
    // zu 'Email (2)'); kommt die Liste aus einer anderen Quelle, gewinnt der
    // erste - ein zweiter Eintrag unter demselben Schluessel waere ohnehin
    // nicht darstellbar.
    if (Object.hasOwn(mapping, header)) {
      continue;
    }

    const alias = lookup.get(headerKey(header));
    if (alias === undefined || taken.has(alias)) {
      mapping[header] = { kind: 'ignore' };
      unmapped.push(header);
      continue;
    }

    taken.add(alias);
    mapping[header] = toTarget(alias);
  }

  const hasName = taken.has('name') || taken.has('first_name') || taken.has('last_name');

  return { mapping, confident: hasName && unmapped.length === 0, detectedSource, unmapped };
}

// ---------------------------------------------------------------------------
// applyMapping
// ---------------------------------------------------------------------------

/**
 * Zellwert aufraeumen. parse.ts liefert die Werte woertlich, inklusive
 * Rand-Leerzeichen ('  Lena  ') - getrimmt wird erst hier, weil erst hier
 * feststeht, dass der Wert in ein Kontaktfeld wandert.
 *
 * Steuerzeichen fliegen raus (ein NUL macht den Datensatz im Volltextindex
 * unauffindbar); Tabulator und Zeilenumbruch bleiben, weil ein mehrzeiliger
 * Firmenname ('Anthropic\nPBC') in der Quelle wirklich so steht.
 */
function cleanCell(value: string): string {
  return stripControlCharacters(value).trim();
}

/** Personennamen stehen einzeilig: alle Whitespace-Folgen zu einem Leerzeichen. */
function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

/** Felder, die aus einer Textspalte 1:1 uebernommen werden. */
const TEXT_FIELDS = [
  'email',
  'linkedin_url',
  'company',
  'title',
  'city',
  'country',
  'phone',
  'how_we_met',
] as const;

type TextField = (typeof TEXT_FIELDS)[number];

/** Schreibt ein nullable Feld - eigener Helfer, damit der Union-Key typsicher bleibt. */
function setNullable(
  target: Partial<NewContactInput>,
  field: TextField | 'birthday',
  value: string | null,
): void {
  target[field] = value;
}

/**
 * Das vollstaendige Ergebnis einer gedeuteten Zeile: der Teil-Kontakt und die
 * Werte, die dabei bewusst unter den Tisch gefallen sind.
 */
export interface MappedRow {
  contact: Partial<NewContactInput>;
  dropped: DroppedValue[];
}

/**
 * Wendet die Zuordnung auf eine Datenzeile an - die vollstaendige Variante.
 *
 * applyMapping (der im Kontrakt festgelegte Name) gibt nur den Kontakt zurueck
 * und ist eine Zeile darunter definiert. Diese Fassung existiert zusaetzlich,
 * weil der Import wissen muss, WAS er nicht uebernommen hat: ein unlesbares
 * Datum und ein Platzhalter in der E-Mail-Spalte sind sonst in der Bilanz von
 * einer leeren Zelle nicht zu unterscheiden.
 *
 * Die Regeln im Einzelnen:
 *
 *   - Vor- und Nachname werden in dieser Reihenfolge mit einem Leerzeichen
 *     verbunden; fehlt eine Haelfte, steht die andere allein da ('Kwame').
 *     Gibt es zusaetzlich eine echte name-Spalte, gewinnt die - sie ist die
 *     genauere Angabe, und die Namensteile sind dann meist eine Zerlegung
 *     davon.
 *   - Eine zugeordnete, aber leere Spalte ergibt null (nicht ''). Damit gibt es
 *     fuer "leer" genau einen Wert, den die Query-Schicht und enrichContact
 *     gleich behandeln. Eine gar nicht zugeordnete Spalte bleibt undefined -
 *     das ist der Unterschied zwischen "die Datei sagt: kein Wert" und "die
 *     Datei sagt dazu nichts".
 *   - Die E-Mail-Spalte wird gegen looksLikeEmail geprueft. Was kein '@' mit
 *     Text links und rechts hat ('-', 'n/a', 'unbekannt'), wird zu null und
 *     als DroppedValue gemeldet, statt als Adresse gespeichert zu werden -
 *     dieselbe Pruefung, mit der dedupe.ts solche Werte schon als Schluessel
 *     ablehnt.
 *   - created_at kommt ueber parseConnectedOn. Ist das Datum unlesbar, wird das
 *     Feld weggelassen (die Query-Schicht setzt dann den aktuellen Zeitstempel)
 *     UND als DroppedValue gemeldet. Ein geratenes Datum waere schlechter als
 *     keines, ein stillschweigend auf heute gesetztes aber auch.
 *   - birthday ebenso ueber parseConnectedOn, zusaetzlich ist die
 *     jahreslose Form '--MM-TT' erlaubt (die kennt das Datenmodell). Unlesbares
 *     wird zu null statt die ganze Zeile scheitern zu lassen.
 *
 * Mehrere Spalten auf dasselbe Ziel kann es nur bei einer von Hand gebauten
 * Zuordnung geben (suggestMapping vergibt jedes Ziel nur einmal). Dann gewinnt
 * die erste Spalte mit einem nicht leeren Wert.
 */
export function mapRow(row: RawRow, mapping: ColumnMapping): MappedRow {
  const values = new Map<ContactField, string>();
  const mappedFields = new Set<ContactField>();
  const dropped: DroppedValue[] = [];
  let firstName = '';
  let lastName = '';

  for (const [header, target] of Object.entries(mapping)) {
    if (target.kind === 'ignore') {
      continue;
    }

    const cell = cleanCell(readCell(row, header));

    if (target.kind === 'name_part') {
      if (cell === '') {
        continue;
      }
      if (target.part === 'first' && firstName === '') {
        firstName = cell;
      } else if (target.part === 'last' && lastName === '') {
        lastName = cell;
      }
      continue;
    }

    mappedFields.add(target.field);
    if (cell !== '' && !values.has(target.field)) {
      values.set(target.field, cell);
    }
  }

  const result: Partial<NewContactInput> = {};

  const name = composeName(values.get('name'), firstName, lastName);
  if (name !== '') {
    result.name = name;
  }

  for (const field of TEXT_FIELDS) {
    if (!mappedFields.has(field)) {
      continue;
    }
    const raw = values.get(field) ?? null;
    if (field === 'email' && raw !== null && !looksLikeEmail(normalizeEmail(raw))) {
      dropped.push({ field: 'email', value: raw, reason: 'keine E-Mail-Adresse' });
      setNullable(result, field, null);
      continue;
    }
    setNullable(result, field, raw);
  }

  if (mappedFields.has('birthday')) {
    setNullable(result, 'birthday', parseBirthday(values.get('birthday')));
  }

  if (mappedFields.has('created_at')) {
    const raw = values.get('created_at') ?? '';
    const createdAt = parseConnectedOn(raw);
    if (createdAt !== null) {
      result.created_at = createdAt;
    } else if (raw !== '') {
      // Leer bedeutet "die Datei sagt nichts dazu" und ist keine Meldung wert.
      // Ein gefuellter, aber unlesbarer Wert dagegen schon: der Kontakt
      // bekommt sonst klammheimlich den Importzeitpunkt als Anlagedatum.
      dropped.push({ field: 'created_at', value: raw, reason: 'unlesbares Datum' });
    }
  }

  return { contact: result, dropped };
}

/**
 * Die im Kontrakt festgelegte Fassung: nur der Kontakt.
 *
 * Benutzt von der Vorschau der CLI, die die verworfenen Werte nicht braucht.
 * Der Import selbst nimmt mapRow.
 */
export function applyMapping(row: RawRow, mapping: ColumnMapping): Partial<NewContactInput> {
  return mapRow(row, mapping).contact;
}

/**
 * Zellzugriff, der nur eigene Properties gelten laesst.
 *
 * Ein von aussen gereichtes RawRow (Meilenstein 3) kann ein gewoehnliches
 * Objektliteral sein. Dort liefert row['constructor'] oder row['toString'] eine
 * geerbte Funktion statt eines Zellwerts - der Wert waere dann kein String und
 * landete ueber String(...) als Unsinn im Kontakt.
 */
function readCell(row: RawRow, header: string): string {
  if (!Object.hasOwn(row, header)) {
    return '';
  }
  const value: unknown = row[header];
  return typeof value === 'string' ? value : '';
}

/** Vollstaendiger Name aus name-Spalte oder aus Vor- und Nachname. */
function composeName(full: string | undefined, first: string, last: string): string {
  const fromFull = collapseWhitespace(full ?? '');
  if (fromFull !== '') {
    return fromFull;
  }
  return collapseWhitespace([first, last].filter((part) => part !== '').join(' '));
}

/** Jahreslose Geburtstagsform des Datenmodells: --MM-TT. */
const BIRTHDAY_WITHOUT_YEAR = /^--\d{2}-\d{2}$/u;

function parseBirthday(raw: string | undefined): string | null {
  const value = raw ?? '';
  if (value === '') {
    return null;
  }
  if (BIRTHDAY_WITHOUT_YEAR.test(value)) {
    return value;
  }
  return parseConnectedOn(value);
}

// ---------------------------------------------------------------------------
// Validierung einer von aussen gereichten Zuordnung
// ---------------------------------------------------------------------------

/**
 * Zusaetzlicher Export (der Kontrakt bleibt erfuellt): das zod-Schema zu
 * ColumnMapping. run.ts benutzt es, weil eine Zuordnung nicht nur aus
 * suggestMapping kommen kann, sondern in Meilenstein 3 auch aus einem
 * Browser-Formular - und eine kaputte Zuordnung dort wuerde sonst als
 * "Feld existiert nicht" erst tief in der Query-Schicht auffallen.
 *
 * Die Feldliste kommt aus TEXT_FIELDS plus den drei Sonderfaellen. Die beiden
 * Zusicherungen darunter halten sie und ContactField deckungsgleich: kommt in
 * types.ts ein Feld dazu, bricht der Typcheck, statt dass eine gueltige
 * Zuordnung hier stillschweigend abgelehnt wird.
 */
const CONTACT_FIELDS = [...TEXT_FIELDS, 'name', 'birthday', 'created_at'] as const satisfies
  readonly ContactField[];

type AssertExtends<Sub extends Super, Super> = Sub;
type _EveryContactFieldIsListed = AssertExtends<ContactField, (typeof CONTACT_FIELDS)[number]>;

export const columnMappingSchema = z.record(
  z.string(),
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('field'), field: z.enum(CONTACT_FIELDS) }),
    z.object({ kind: z.literal('name_part'), part: z.enum(['first', 'last']) }),
    z.object({ kind: z.literal('ignore') }),
  ]),
);
