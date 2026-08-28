/**
 * Textnormalisierung, die an zwei Stellen identisch gebraucht wird:
 * in lib/queries.ts (JavaScript-Seite) und als SQL-Funktion norm_text, die
 * lib/db.ts beim Verbindungsaufbau registriert. Deshalb liegt sie in einem
 * eigenen Modul und nicht in einer der beiden Dateien - sonst laufen die
 * Faltung im Filter und die Faltung in der Abfrage irgendwann auseinander.
 */

/**
 * Kleinschreibung ohne diakritische Zeichen. Entspricht dem, was der
 * FTS-Tokenizer (unicode61 remove_diacritics 2) mit dem Text macht, damit
 * Suchbegriffe und Belege dieselbe Grundlage haben.
 *
 * SQLites eingebautes COLLATE NOCASE faltet ausschliesslich ASCII A-Z und
 * taugt fuer die Sprachen dieses Projekts nicht: 'MÜNCHEN' und 'München'
 * waeren dort zwei verschiedene Staedte.
 */
export function normalizeText(value: string): string {
  return value.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

/**
 * Entfernt Steuerzeichen aus Text, der gespeichert wird - insbesondere NUL.
 *
 * Ein NUL im Namen laesst sich zwar speichern, ist danach aber nicht mehr
 * auffindbar (die Suche entfernt es aus dem Suchbegriff) und macht in jeder
 * Ausgabe Aerger. Tabulator, Zeilenumbruch und Wagenruecklauf bleiben
 * ausdruecklich erhalten: Notizen und laengere Needs sind mehrzeilig.
 */
export function stripControlCharacters(value: string): string {
  return value.replace(/\p{Cc}/gu, (char) =>
    char === '\t' || char === '\n' || char === '\r' ? char : '',
  );
}

/**
 * Entfernt aus einem Suchbegriff alles, was der Volltextindex ohnehin nicht
 * als Wortzeichen kennt und was die FTS5-Syntax stoert: Steuerzeichen
 * (ein NUL laesst better-sqlite3 beim Binden mit "unterminated string"
 * abbrechen), Formatzeichen, einzelne Surrogate, Private-Use- und nicht
 * zugewiesene Codepunkte.
 *
 * Bewusst schaerfer als stripControlCharacters: ein fluechtiger Suchbegriff
 * gewinnt durch diese Zeichen nichts, gespeicherter Text dagegen schon.
 */
export function stripSearchNoise(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}]+/gu, '');
}
