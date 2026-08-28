/**
 * Formatierung fuer die Oberflaeche: Datum, Relativzeit, Namenskuerzel.
 *
 * Regeln dieser Datei:
 *   - Deutsche Ausgabe, Intl-API, keine externe Bibliothek.
 *   - Jede Funktion vertraegt null, undefined und Muell als Eingabe und liefert
 *     dann den mitgegebenen Ersatztext. Die Oberflaeche soll nie an einem
 *     leeren Feld scheitern, und ein "Invalid Date" in einer Tabellenzelle ist
 *     schlimmer als ein Gedankenstrich.
 *   - Reine Funktionen ohne Zustand. `now` ist ueberall als Argument
 *     durchgereicht, damit sich die Ausgabe testen laesst.
 */

/** Ersatztext, wenn kein Wert da ist. */
const DASH = '—';

/**
 * Monatskuerzel als feste Tabelle.
 *
 * Warum nicht Intl mit month: 'short': de-DE liefert dort "Mär." mit
 * diakritischem Zeichen und Punkt. Verlangt ist die kompakte Schreibweise
 * ("14. Mrz 2023"), die in dichten Tabellenspalten schmaler und ruhiger
 * laeuft. Der Rest der Formatierung (Uhrzeit, Relativzeit) kommt weiterhin
 * aus Intl - dort gibt es nichts, was von Hand besser waere.
 */
const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mrz',
  'Apr',
  'Mai',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Okt',
  'Nov',
  'Dez',
] as const;

/** Nur-Datum: YYYY-MM-DD. */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Geburtstag ohne Jahr: --MM-DD. */
const BIRTHDAY_NO_YEAR = /^--(\d{2})-(\d{2})$/;

const timeFormatter = new Intl.DateTimeFormat('de-DE', {
  hour: '2-digit',
  minute: '2-digit',
});

const relativeFormatter = new Intl.RelativeTimeFormat('de-DE', { numeric: 'auto' });

/**
 * Parst einen ISO-Wert zu einem lokalen Date.
 *
 * Der Sonderfall YYYY-MM-DD wird bewusst NICHT an Date.parse gegeben: die Norm
 * deutet einen reinen Datums-String als UTC-Mitternacht, und in jeder Zeitzone
 * westlich von Greenwich zeigt getDate() danach den Vortag an. Aus einem
 * Geburtstag am 14.03. wird so der 13.03. Datumsangaben ohne Uhrzeit sind
 * Kalendertage und werden deshalb als lokale Mitternacht gebaut.
 */
function parseIso(value: string): Date | null {
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }

  const dateOnly = DATE_ONLY.exec(trimmed);
  if (dateOnly !== null) {
    const year = Number(dateOnly[1]);
    const month = Number(dateOnly[2]);
    const day = Number(dateOnly[3]);
    const date = new Date(year, month - 1, day);
    // new Date(2023, 12, 40) rechnet still weiter - der Rueckvergleich faengt
    // Werte ab, die als Datum gar nicht existieren.
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      return null;
    }
    return date;
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Mitternacht desselben Kalendertags, lokal. Basis jedes Tagesvergleichs. */
function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function monthShort(monthIndex: number): string {
  return MONTHS_SHORT[monthIndex] ?? '';
}

/**
 * ISO-Datum als "14. Mrz 2023".
 *
 * Nimmt sowohl reine Datumsangaben ('2023-03-14') als auch Zeitstempel
 * ('2023-03-14T08:12:00.000Z') entgegen.
 */
export function formatDate(value: string | null | undefined, fallback: string = DASH): string {
  if (value === null || value === undefined) {
    return fallback;
  }
  const date = parseIso(value);
  if (date === null) {
    return fallback;
  }
  return `${date.getDate()}. ${monthShort(date.getMonth())} ${date.getFullYear()}`;
}

/** Wie formatDate, zusaetzlich mit Uhrzeit: "14. Mrz 2023, 09:12". */
export function formatDateTime(value: string | null | undefined, fallback: string = DASH): string {
  if (value === null || value === undefined) {
    return fallback;
  }
  const date = parseIso(value);
  if (date === null) {
    return fallback;
  }
  return `${formatDate(value, fallback)}, ${timeFormatter.format(date)}`;
}

/**
 * Abstand zu heute in Worten: "heute", "gestern", "vor 3 Tagen",
 * "vor 2 Wochen", "vor 5 Monaten", "vor 2 Jahren". Zukunft ebenso
 * ("morgen", "in 3 Tagen"). Ohne Wert: "noch nie".
 *
 * Gerechnet wird in Kalendertagen, nicht in 24-Stunden-Bloecken: gestern um
 * 23:00 Uhr ist "gestern", auch wenn erst zwei Stunden vergangen sind.
 */
export function formatRelative(
  value: string | null | undefined,
  now: Date = new Date(),
  fallback = 'noch nie',
): string {
  if (value === null || value === undefined) {
    return fallback;
  }
  const date = parseIso(value);
  if (date === null) {
    return fallback;
  }

  const dayMs = 24 * 60 * 60 * 1000;
  const days = Math.round((startOfDay(date).getTime() - startOfDay(now).getTime()) / dayMs);
  const distance = Math.abs(days);

  if (distance < 7) {
    return relativeFormatter.format(days, 'day');
  }
  if (distance < 30) {
    // Math.trunc rundet zur Null hin: -8 Tage ergeben "vor 1 Woche" und nicht
    // "vor 2 Wochen". Lieber untertreiben als eine Naehe behaupten, die nicht da ist.
    return relativeFormatter.format(Math.trunc(days / 7), 'week');
  }
  if (distance < 365) {
    return relativeFormatter.format(Math.trunc(days / 30), 'month');
  }
  return relativeFormatter.format(Math.trunc(days / 365), 'year');
}

/**
 * Geburtstag, auch ohne Jahrgang.
 *
 * '1990-03-14' wird zu "14. Mrz 1990", '--03-14' zu "14. Mrz". Die jahreslose
 * Form kennt das Datenmodell ausdruecklich (siehe lib/types.ts), sie ist der
 * Normalfall bei allem, was aus einem Adressbuch kommt.
 */
export function formatBirthday(value: string | null | undefined, fallback: string = DASH): string {
  if (value === null || value === undefined) {
    return fallback;
  }
  const trimmed = value.trim();

  const withoutYear = BIRTHDAY_NO_YEAR.exec(trimmed);
  if (withoutYear !== null) {
    const month = Number(withoutYear[1]);
    const day = Number(withoutYear[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      return fallback;
    }
    return `${day}. ${monthShort(month - 1)}`;
  }

  return formatDate(trimmed, fallback);
}

/**
 * Namenskuerzel fuer Avatare: "Simon Fuhrbach" wird zu "SF".
 *
 * Genommen werden der erste und der letzte Namensteil; Einzelnamen ergeben
 * einen Buchstaben. Array.from statt charAt, damit ein Name, der mit einem
 * Zeichen ausserhalb der Basic Multilingual Plane beginnt, nicht in zwei
 * halbe Zeichen zerfaellt.
 */
export function formatInitials(name: string | null | undefined, fallback = '?'): string {
  if (name === null || name === undefined) {
    return fallback;
  }
  const parts = name
    .split(/[\s\-_.]+/)
    .map((part) => part.trim())
    .filter((part) => /[\p{L}\p{N}]/u.test(part));

  if (parts.length === 0) {
    return fallback;
  }

  const first = parts[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1] ?? '') : '';
  const letters = [firstLetter(first), firstLetter(last)].join('');

  return letters === '' ? fallback : letters.toLocaleUpperCase('de-DE');
}

function firstLetter(part: string): string {
  for (const char of part) {
    if (/[\p{L}\p{N}]/u.test(char)) {
      return char;
    }
  }
  return '';
}
