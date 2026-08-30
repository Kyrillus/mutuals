/**
 * Normalisierung der Felder, ueber die der Import Dubletten erkennt.
 *
 * Diese Datei implementiert die Faltung NICHT neu. Die Bausteine liegen bereits
 * in Meilenstein 1:
 *   - lib/text.ts       normalizeText (NFD, Combining Marks weg, lowercase),
 *                       stripControlCharacters
 *   - lib/queries.ts    normalizePersonName, normalizeLinkedinUrl - dieselben
 *                       Funktionen, die die Datenbankschicht beim Schreiben und
 *                       bei findContactByLinkedinUrl benutzt.
 *
 * Warum das wichtig ist: der Dedup-Schluessel muss dieselbe Faltung sein wie
 * die, mit der der Wert gespeichert und gesucht wird. Eine zweite, leicht
 * abweichende Implementierung an dieser Stelle wuerde bedeuten, dass der Import
 * einen Kontakt als neu ansieht, den findContactByLinkedinUrl anschliessend
 * sehr wohl findet - oder umgekehrt. Ausnahmen gibt es deshalb keine: die
 * Vereinheitlichung des LinkedIn-Hosts auf www.linkedin.com stand frueher hier
 * und liegt jetzt in lib/queries.ts, wo auch gespeichert und gesucht wird.
 */

import { normalizeLinkedinUrl as canonicalLinkedinUrl, normalizePersonName } from '../queries';
import { normalizeText, stripControlCharacters } from '../text';

/**
 * Normalisierter Personenname - Stufe 3 der Dedup-Kaskade.
 *
 * Kleinschreibung, ohne Diakritika, Whitespace kollabiert, getrimmt:
 * 'Juergen  Mueller ' und 'JURGEN MULLER' ergeben denselben Schluessel.
 *
 * Delegiert bewusst an normalizePersonName aus lib/queries.ts. Dort steht die
 * Regel, die auch der Rest des Projekts benutzt; hier steht nur der Name, unter
 * dem der Import sie kennt.
 */
export function normalizeName(raw: string): string {
  return normalizePersonName(raw);
}

/**
 * Normalisierte E-Mail-Adresse - Stufe 2 der Dedup-Kaskade.
 *
 * Getrimmt, ohne Steuerzeichen, ohne jeglichen Whitespace, kleingeschrieben.
 *
 * Bewusst OHNE Diakritika-Faltung (also nicht ueber normalizeText): 'a@b.de'
 * und 'ä@b.de' sind zwei verschiedene Postfaecher, das Zusammenfalten waere
 * hier ein Datenfehler und kein Treffer. Der Localpart ist laut RFC 5321
 * streng genommen case-sensitiv; in der Praxis behandelt ihn jeder Anbieter
 * case-insensitiv, und fuer die Dublettenpruefung ist das die richtige Wahl -
 * 'Anna@Example.com' aus dem einen Export und 'anna@example.com' aus dem
 * anderen sind dieselbe Person.
 *
 * Whitespace faellt komplett weg, nicht nur aussen: eine gueltige
 * (ungequotete) Adresse enthaelt keinen, ein Leerzeichen mitten drin stammt
 * also aus dem Copy-and-paste und nicht aus der Adresse.
 */
export function normalizeEmail(raw: string): string {
  return stripControlCharacters(raw)
    .replace(/\s+/gu, '')
    .toLowerCase();
}

/**
 * Sieht der Wert ueberhaupt wie eine E-Mail-Adresse aus?
 *
 * ERP- und CRM-Exporte tragen in E-Mail-Spalten regelmaessig Platzhalter wie
 * '-', 'n/a', 'keine' oder 'unbekannt'. Verlangt wird deshalb das Minimum einer
 * Adresse: genau ein '@', links davon etwas, rechts davon etwas.
 *
 * Bewusst keine vollstaendige RFC-Pruefung. Der Wert wird an zwei Stellen
 * gebraucht - als Dublettenschluessel (dedupe.ts) und als zu speichernder Wert
 * (mapping.ts) - und beide Male ist eine zu strenge Regel teurer als eine zu
 * lasche: sie kostet echte Treffer bzw. echte Adressen.
 *
 * Dass beide dieselbe Funktion benutzen, ist der eigentliche Punkt. Vorher
 * wusste dedupe.ts, dass 'n/a' keine Adresse ist, und mapping.ts schrieb
 * denselben Wert trotzdem in contacts.email.
 *
 * Erwartet wird der bereits normalisierte Wert aus normalizeEmail.
 */
export function looksLikeEmail(normalized: string): boolean {
  const parts = normalized.split('@');
  return parts.length === 2 && parts[0] !== '' && parts[1] !== '';
}

/**
 * Kanonische LinkedIn-URL - Stufe 1 der Dedup-Kaskade.
 *
 * Die Faltung selbst steht in lib/queries.ts (Schema auf https, Host klein und
 * auf www.linkedin.com vereinheitlicht, Query und Fragment weg, abschliessender
 * Slash weg) - genau diese Form steht auch in der Spalte
 * contacts.linkedin_url. Damit landen
 *   https://www.linkedin.com/in/paulbrandner
 *   http://linkedin.com/in/paulbrandner/
 *   https://www.linkedin.com/in/paulbrandner?utm_source=share
 *   https://de.linkedin.com/in/paulbrandner
 * auf demselben Schluessel UND auf demselben gespeicherten Wert.
 *
 * Hier kommen nur zwei Dinge dazu, die den Wert nicht veraendern, sondern nur
 * den Vergleich robuster machen: Steuerzeichen fliegen vorher raus, und das
 * Ergebnis wird kleingeschrieben. Der Pfad bleibt in der Datenbank in seiner
 * Originalschreibweise stehen; verglichen wird dort ohnehin COLLATE NOCASE, und
 * LinkedIn-Profilpfade sind nicht zwischen Gross und Klein zu unterscheiden.
 */
export function normalizeLinkedinUrl(raw: string): string {
  return canonicalLinkedinUrl(stripControlCharacters(raw)).toLowerCase();
}

// ---------------------------------------------------------------------------
// Datum ("Connected On")
// ---------------------------------------------------------------------------

/**
 * Monatsnamen, bereits durch normalizeText gefaltet (klein, ohne Diakritika).
 *
 * Englisch vollstaendig, weil der LinkedIn-Export in englischer Oberflaeche
 * '14 Mar 2023' liefert. Deutsch dazu, weil derselbe Export bei deutscher
 * Oberflaeche '14. Mai 2023' bzw. 'Mär'/'Okt'/'Dez' liefert - nach der
 * Diakritika-Faltung sind das 'mar', 'okt', 'dez', 'marz'.
 */
const MONTH_NUMBERS: ReadonlyMap<string, number> = new Map([
  ['jan', 1], ['january', 1], ['januar', 1], ['janner', 1],
  ['feb', 2], ['february', 2], ['februar', 2],
  ['mar', 3], ['march', 3], ['marz', 3], ['maerz', 3],
  ['apr', 4], ['april', 4],
  ['may', 5], ['mai', 5],
  ['jun', 6], ['june', 6], ['juni', 6],
  ['jul', 7], ['july', 7], ['juli', 7],
  ['aug', 8], ['august', 8],
  ['sep', 9], ['sept', 9], ['september', 9],
  ['oct', 10], ['october', 10], ['okt', 10], ['oktober', 10],
  ['nov', 11], ['november', 11],
  ['dec', 12], ['december', 12], ['dez', 12], ['dezember', 12],
]);

/** Aeltestes und juengstes plausibles Jahr fuer ein Kontaktdatum. */
const MIN_YEAR = 1900;
const MAX_YEAR = 2999;

/** Jahr-zuerst und damit eindeutig: 2023-03-14, 2023/3/4, 2023.03.14, mit optionaler Uhrzeit. */
const ISO_LIKE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/u;

/** Deutsches Datum: 14.03.2023 oder 1.1.2020. Punkt-Trennung ist immer Tag zuerst. */
const GERMAN_DOTTED = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/u;

/**
 * 'Connected On' und verwandte Datumsspalten nach ISO 'YYYY-MM-DD'.
 *
 * Erkannt werden:
 *   14 Mar 2023, 14. März 2023, 14 March 2023   (Tag Monatsname Jahr)
 *   Mar 14, 2023, March 14 2023                 (Monatsname Tag Jahr)
 *   2023-03-14, 2023/03/14, 2023-03-14T09:12:00Z (Jahr zuerst)
 *   14.03.2023                                  (deutsch, Punkte)
 *
 * Bewusst NICHT erkannt (Rueckgabe null statt Raten):
 *   - '03/14/2023' und '14/03/2023'. Ob Tag oder Monat vorn steht, entscheidet
 *     die Locale des Exports, nicht der Wert. Bei '03/04/2023' ist beides
 *     plausibel; ein Teil der Zeilen richtig und ein Teil still falsch zu raten
 *     ist schlechter, als das Feld leer zu lassen. Wer solche Dateien hat, muss
 *     das Format beim Mapping angeben.
 *   - Zweistellige Jahre ('14 Mar 23') - das Jahrhundert waere geraten.
 *   - Excel-Seriennummern ('44999'). Ob eine nackte Zahl ein Datum ist, weiss
 *     nur der Parser, der den Zelltyp kennt (lib/import/parse.ts); hier waere
 *     jede Zahl ein Datum.
 *
 * Unlesbares gibt null - nicht heute, nicht die Epoche, keine Exception.
 * Kalendarisch unmoegliche Daten ('31 Feb 2023', '2023-02-30') gelten als
 * unlesbar.
 *
 * Nicht zu raten ist aber nur die halbe Miete: ein verworfenes Datum muss auch
 * sichtbar sein, sonst traegt der Kontakt den Importzeitpunkt und niemand
 * merkt es. Der Aufrufer (mapping.ts) meldet deshalb jeden nicht leeren Wert,
 * der hier null ergibt, als DroppedValue in die Bilanz.
 */
export function parseConnectedOn(raw: string): string | null {
  const value = stripControlCharacters(raw).trim();
  if (value === '') {
    return null;
  }

  const isoLike = ISO_LIKE.exec(value);
  if (isoLike !== null) {
    return toIsoDate(isoLike[1], isoLike[2], isoLike[3]);
  }

  const german = GERMAN_DOTTED.exec(value);
  if (german !== null) {
    return toIsoDate(german[3], german[2], german[1]);
  }

  // Textform. Ueber Tokens statt ueber eine grosse Regex, weil damit
  // '14 Mar 2023', '14. März 2023', 'Mar 14, 2023' und 'March 14 2023'
  // derselbe Fall sind: drei Tokens, und die Reihenfolge ergibt sich daraus,
  // welches davon der Monatsname ist.
  const tokens = value.split(/[\s,]+/u).filter((token) => token !== '');
  if (tokens.length !== 3) {
    return null;
  }
  const [first, second, third] = tokens;
  if (first === undefined || second === undefined || third === undefined) {
    return null;
  }

  const monthFromFirst = monthNumber(first);
  if (monthFromFirst !== null) {
    // Monatsname Tag Jahr
    return toIsoDate(third, monthFromFirst, second);
  }

  const monthFromSecond = monthNumber(second);
  if (monthFromSecond !== null) {
    // Tag Monatsname Jahr
    return toIsoDate(third, monthFromSecond, first);
  }

  return null;
}

/**
 * Monatsnummer zu einem Token, oder null. Der abschliessende Punkt einer
 * Abkuerzung ('Mar.', 'Sept.') faellt weg, danach entscheidet die gefaltete
 * Schreibweise.
 */
function monthNumber(token: string): number | null {
  const key = normalizeText(token).replace(/\.+$/u, '');
  return MONTH_NUMBERS.get(key) ?? null;
}

/**
 * Baut 'YYYY-MM-DD' aus den drei Bestandteilen und prueft dabei, dass es den
 * Tag wirklich gibt. Die Pruefung laeuft ueber Date.UTC und den Rueckweg:
 * JavaScript rollt einen 31. Februar stillschweigend auf den 3. Maerz weiter,
 * genau das soll hier als "unlesbar" durchfallen.
 *
 * Die Tagesangabe darf mit fuehrendem Punkt-Rest oder fuehrender Null kommen
 * ('14.', '04'), deshalb wird sie hier und nicht beim Aufrufer bereinigt.
 */
function toIsoDate(
  yearRaw: string | undefined,
  monthRaw: string | number | undefined,
  dayRaw: string | undefined,
): string | null {
  const year = toInteger(yearRaw);
  const month = typeof monthRaw === 'number' ? monthRaw : toInteger(monthRaw);
  const day = toInteger(dayRaw);

  if (year === null || month === null || day === null) {
    return null;
  }
  if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    return null;
  }

  const pad = (n: number, width: number): string => String(n).padStart(width, '0');
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** Ganze Zahl aus einem Token, das nur aus Ziffern (plus Schlusspunkt) besteht. */
function toInteger(raw: string | undefined): number | null {
  if (raw === undefined) {
    return null;
  }
  const digits = raw.replace(/\.+$/u, '');
  if (!/^\d{1,4}$/u.test(digits)) {
    return null;
  }
  return Number.parseInt(digits, 10);
}
