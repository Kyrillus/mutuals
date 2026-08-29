/**
 * Die Zielfelder des Imports, uebersetzt fuer die Auswahlfelder ueber der
 * Vorschautabelle - und die Pruefung, ob die Zuordnung in sich stimmt.
 *
 * Warum hier und nicht in der Tabelle: die Auswahl entsteht in
 * preview-table.tsx, die Pruefung braucht import-view.tsx (dort haengt der
 * Import-Knopf daran), und beide muessen von derselben Liste sprechen. Ein
 * zweites Label "E-Mail-Adresse" an der einen Stelle und "E-Mail" an der
 * anderen waere schon der Anfang von zwei Wahrheiten.
 *
 * Ein <select> kann nur Zeichenketten tragen, MappingTarget ist aber ein
 * Objekt mit drei Auspraegungen. targetToValue/valueToTarget sind die
 * Uebersetzung zwischen beidem; ausserhalb dieser Datei taucht die
 * Zeichenkettenform nur als undurchsichtiger Schluessel auf.
 */
import type { ColumnMapping, ContactField, MappingTarget } from '@/lib/import/types';

/**
 * Beschriftung jedes Zielfeldes. Als Record und nicht als Liste, damit ein
 * neues ContactField in lib/import/types.ts hier den Typcheck bricht, statt
 * ohne Beschriftung in der Auswahl zu fehlen.
 */
const FIELD_LABELS: Record<ContactField, string> = {
  name: 'Name',
  email: 'E-Mail',
  linkedin_url: 'LinkedIn-Profil',
  company: 'Firma',
  title: 'Position',
  city: 'Stadt',
  country: 'Land',
  phone: 'Telefon',
  birthday: 'Geburtstag',
  how_we_met: 'Kennengelernt',
  created_at: 'Verbunden am',
};

/**
 * Reihenfolge in der Auswahlliste: erst was fast jede Datei hat, dann das
 * Seltene. Die Zusicherung darunter haelt die Liste vollstaendig - ein Feld,
 * das nur im Record steht, waere nicht auswaehlbar.
 */
const FIELD_ORDER = [
  'name',
  'email',
  'linkedin_url',
  'company',
  'title',
  'city',
  'country',
  'phone',
  'birthday',
  'how_we_met',
  'created_at',
] as const satisfies readonly ContactField[];

type AssertExtends<Sub extends Super, Super> = Sub;
type _EveryFieldIsSelectable = AssertExtends<ContactField, (typeof FIELD_ORDER)[number]>;

export const IGNORE_VALUE = 'ignore';
const FIRST_NAME_VALUE = 'name_part:first';
const LAST_NAME_VALUE = 'name_part:last';
const NAME_VALUE = 'field:name';

export interface TargetOption {
  value: string;
  label: string;
}

/**
 * "Nicht importieren" steht ganz oben, weil es das haeufigste Ziel einer
 * unbekannten Spalte ist und weil es der Zustand ist, in dem Daten verloren
 * gehen - der gehoert an die sichtbarste Stelle, nicht ans Listenende.
 */
export const TARGET_OPTIONS: readonly TargetOption[] = [
  { value: IGNORE_VALUE, label: 'Nicht importieren' },
  { value: NAME_VALUE, label: FIELD_LABELS.name },
  { value: FIRST_NAME_VALUE, label: 'Vorname' },
  { value: LAST_NAME_VALUE, label: 'Nachname' },
  ...FIELD_ORDER.filter((field) => field !== 'name').map((field) => ({
    value: `field:${field}`,
    label: FIELD_LABELS[field],
  })),
];

const LABEL_BY_VALUE = new Map(TARGET_OPTIONS.map((option) => [option.value, option.label]));
const FIELD_BY_VALUE = new Map<string, ContactField>(
  FIELD_ORDER.map((field) => [`field:${field}`, field]),
);

export function targetToValue(target: MappingTarget): string {
  if (target.kind === 'field') {
    return `field:${target.field}`;
  }
  if (target.kind === 'name_part') {
    return target.part === 'first' ? FIRST_NAME_VALUE : LAST_NAME_VALUE;
  }
  return IGNORE_VALUE;
}

/**
 * Gegenrichtung. Ein Wert, den die Liste nicht kennt, wird zu 'ignore' statt
 * zu einem Fehler: er kann nur aus einem manipulierten DOM stammen, und dann
 * ist "diese Spalte wird nicht importiert" die harmlose Deutung.
 */
export function valueToTarget(value: string): MappingTarget {
  if (value === FIRST_NAME_VALUE) {
    return { kind: 'name_part', part: 'first' };
  }
  if (value === LAST_NAME_VALUE) {
    return { kind: 'name_part', part: 'last' };
  }
  const field = FIELD_BY_VALUE.get(value);
  if (field !== undefined) {
    return { kind: 'field', field };
  }
  return { kind: 'ignore' };
}

function labelForValue(value: string): string {
  return LABEL_BY_VALUE.get(value) ?? 'Nicht importieren';
}

/**
 * Zugriff auf die Zuordnung einer Spalte.
 *
 * Object.hasOwn und nicht einfach mapping[header]: die Zuordnung kommt vom
 * Server als gewoehnliches Objekt. Eine Spalte mit dem Namen 'constructor'
 * oder 'toString' lieferte sonst eine geerbte Funktion statt eines Ziels.
 * Fehlt der Eintrag, gilt die Spalte als nicht importiert - das ist die
 * Deutung, die keine Daten erfindet.
 */
export function readTarget(mapping: ColumnMapping, header: string): MappingTarget {
  if (!Object.hasOwn(mapping, header)) {
    return { kind: 'ignore' };
  }
  return mapping[header] ?? { kind: 'ignore' };
}

/**
 * Zuordnung mit geaenderter Spalte.
 *
 * Der berechnete Schluessel ist Absicht und kein Umweg: `{ __proto__: x }`
 * setzt in einem Objektliteral den Prototyp, `{ ['__proto__']: x }` legt eine
 * gewoehnliche Property an. Eine Datei mit einer Spalte dieses Namens wuerde
 * sonst still ihre Zuordnung verlieren.
 */
export function withTarget(
  mapping: ColumnMapping,
  header: string,
  target: MappingTarget,
): ColumnMapping {
  return { ...mapping, [header]: target };
}

export interface MappingAnalysis {
  /** Spalten, die auf ein Ziel zeigen, das eine andere Spalte schon belegt. */
  conflictingHeaders: ReadonlySet<string>;
  /** Die doppelt vergebenen Ziele, ausgeschrieben, in Lesereihenfolge. */
  conflictLabels: readonly string[];
  /** Kein Ziel fuellt den Namen - dann bliebe jede Zeile liegen. */
  missingName: boolean;
  /** Name UND Vorname/Nachname vergeben: die Teile bleiben dann ungenutzt. */
  nameOverridesParts: boolean;
  /** Wie viele Spalten nicht uebernommen werden. */
  ignoredCount: number;
}

/**
 * Prueft die Zuordnung, bevor sie zum Server geht.
 *
 * Zwei Spalten auf dasselbe Ziel sind kein Fehler, den der Import melden
 * wuerde - lib/import/mapping.ts nimmt in dem Fall stillschweigend die erste
 * nicht leere Zelle, und die zweite Spalte ist weg, ohne dass es irgendwo
 * auftaucht. Genau deshalb wird hier davor gewarnt und der Import gesperrt.
 *
 * Vorname und Nachname sind ausgenommen: sie sind zwei verschiedene Ziele, die
 * gemeinsam EIN Feld fuellen, und der LinkedIn-Export liefert sie genau so.
 */
export function analyzeMapping(
  headers: readonly string[],
  mapping: ColumnMapping,
): MappingAnalysis {
  const firstHolder = new Map<string, string>();
  const conflictingHeaders = new Set<string>();
  const conflictLabels: string[] = [];
  let ignoredCount = 0;
  let hasFullName = false;
  let hasNamePart = false;

  for (const header of headers) {
    const value = targetToValue(readTarget(mapping, header));

    if (value === IGNORE_VALUE) {
      ignoredCount += 1;
      continue;
    }
    if (value === NAME_VALUE) {
      hasFullName = true;
    } else if (value === FIRST_NAME_VALUE || value === LAST_NAME_VALUE) {
      hasNamePart = true;
    }

    const holder = firstHolder.get(value);
    if (holder === undefined) {
      firstHolder.set(value, header);
      continue;
    }

    conflictingHeaders.add(holder);
    conflictingHeaders.add(header);
    const label = labelForValue(value);
    if (!conflictLabels.includes(label)) {
      conflictLabels.push(label);
    }
  }

  return {
    conflictingHeaders,
    conflictLabels,
    missingName: !hasFullName && !hasNamePart,
    nameOverridesParts: hasFullName && hasNamePart,
    ignoredCount,
  };
}
