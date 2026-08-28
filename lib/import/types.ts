/**
 * Die gemeinsamen Typen des Imports.
 *
 * Der Import zerfaellt in vier Schritte, die nacheinander laufen und je einen
 * eigenen Typ aus dieser Datei als Uebergabe benutzen:
 *
 *   Datei/Buffer --parse--> ParsedFile --suggestMapping--> MappingSuggestion
 *                --applyMapping--> Partial<NewContactInput> --run--> ImportSummary
 *
 * Alle Module unter lib/import/ beziehen ihre Typen von hier, damit CLI
 * (scripts/import.ts) und der spaetere Upload im Interface dieselbe Kette
 * benutzen und nicht zwei Varianten davon entstehen.
 */

import type { NewContactInput } from '../types';

/**
 * Zeile der Quelldatei, bereits auf die Kopfzeile abgebildet: Schluessel ist
 * der Headername, Wert der Zellinhalt. Bewusst durchgehend string - was in der
 * Datei steht, ist Text; die Deutung (Datum, E-Mail, URL) passiert erst in
 * normalize.ts. Fehlende Zellen stehen als leerer String drin, nie undefined,
 * damit der Zugriff kein Sonderfall ist.
 */
export type RawRow = Record<string, string>;

/** Das Ergebnis von parse.ts: Kopfzeile, Datenzeilen und wie sie gefunden wurden. */
export interface ParsedFile {
  headers: string[];
  rows: RawRow[];
  /** wie viele Zeilen vor der Headerzeile uebersprungen wurden */
  preambleLines: number;
  format: 'csv' | 'xlsx' | 'xls';
  sheetName?: string;
  /**
   * Was beim Lesen auffiel, ohne den Vorgang zu verhindern: eine Datei, die
   * nicht UTF-8 kodiert war, eine .xlsx, die in Wahrheit Text ist, ein
   * uebersprungenes erstes Arbeitsblatt.
   *
   * Der Grund fuer das Feld: parse.ts kann in solchen Faellen weiterarbeiten,
   * aber die Entscheidung, ob das Ergebnis brauchbar ist, gehoert dem Menschen.
   * Ohne einen Kanal dafuer bliebe nur "still weitermachen" (so entsteht
   * Mojibake in der Datenbank) oder "abbrechen" (dann ist eine lesbare Datei
   * nicht importierbar). Die CLI gibt die Zeilen vor der Rueckfrage aus, der
   * Upload in Meilenstein 3 zeigt sie im Dialog.
   *
   * Optional, damit ein von Hand gebautes ParsedFile (Tests, HTTP-Request) den
   * Kontrakt weiterhin ohne dieses Feld erfuellt.
   */
  warnings?: string[];
}

/**
 * Die Spalten eines Kontakts, die ein Import befuellen darf. Teilmenge der
 * schreibbaren Spalten aus lib/types.ts - Felder wie closeness, stage oder
 * status stehen bewusst nicht drin: die vergibt der Mensch spaeter in der
 * Anwendung, nicht die CSV.
 */
export type ContactField =
  | 'name'
  | 'email'
  | 'linkedin_url'
  | 'company'
  | 'title'
  | 'city'
  | 'country'
  | 'phone'
  | 'birthday'
  | 'how_we_met'
  | 'created_at';

/**
 * Absicherung zur Uebersetzungszeit: jedes ContactField muss eine Spalte sein,
 * die NewContactInput auch wirklich kennt. Wird eines der Felder in
 * lib/types.ts umbenannt, schlaegt hier der Typcheck fehl statt still ein Feld
 * im Import zu verlieren.
 */
type AssertExtends<Sub extends Super, Super> = Sub;
type _ContactFieldsAreWritable = AssertExtends<ContactField, keyof NewContactInput>;

/**
 * Wohin eine Spalte der Quelldatei zeigt.
 *
 * 'name_part' ist der Grund, warum das kein simples Record<string, ContactField>
 * ist: LinkedIn liefert Vor- und Nachname getrennt, der Kontakt hat aber nur
 * ein name-Feld. Zwei Spalten zeigen also auf dasselbe Ziel und muessen dabei
 * ihre Reihenfolge behalten.
 */
export type MappingTarget =
  | { kind: 'field'; field: ContactField }
  | { kind: 'name_part'; part: 'first' | 'last' }
  | { kind: 'ignore' };

/** Schluessel = Headername */
export type ColumnMapping = Record<string, MappingTarget>;

export interface MappingSuggestion {
  mapping: ColumnMapping;
  /** true, wenn das Layout sicher erkannt wurde (z.B. LinkedIn) */
  confident: boolean;
  detectedSource: 'linkedin' | 'unknown';
  /** Header, fuer die kein Ziel gefunden wurde */
  unmapped: string[];
}

/**
 * Ein Wert, der in der Quellzeile stand, aber bewusst nicht uebernommen wurde.
 *
 * Der Import raet nicht: ein Datum, dessen Format nicht eindeutig ist, und ein
 * Platzhalter in der E-Mail-Spalte werden verworfen statt falsch gespeichert.
 * Verworfen und verschwiegen sind aber zwei verschiedene Dinge - ohne diese
 * Meldung ist eine Zeile mit unlesbarem Datum in der Bilanz nicht von einer
 * mit leerer Datumsspalte zu unterscheiden, und der Fehler faellt erst Monate
 * spaeter in der Oberflaeche auf. value traegt deshalb den Originaltext mit:
 * damit kann der Nutzer das Format beim naechsten Lauf angeben.
 */
export interface DroppedValue {
  field: ContactField;
  /** der Zellwert, so wie er in der Datei stand */
  value: string;
  reason: 'unlesbares Datum' | 'keine E-Mail-Adresse';
}

/** Was mit einer einzelnen Datenzeile passiert ist. */
export interface ImportRowResult {
  /** 1-basiert, bezogen auf die Datenzeilen (ohne Header) */
  rowNumber: number;
  outcome: 'created' | 'enriched' | 'skipped' | 'error';
  contactId?: number;
  matchedBy?: 'linkedin_url' | 'email' | 'name';
  /** bei skipped/error: warum */
  reason?: string;
  /**
   * Werte aus dieser Zeile, die nicht in den Kontakt gewandert sind. Leer bzw.
   * nicht gesetzt im Normalfall.
   */
  dropped?: DroppedValue[];
}

/**
 * Bilanz eines Importlaufs. total zaehlt die Datenzeilen; created, enriched,
 * skipped und errors summieren sich zu total, und rows haelt die Begruendung
 * je Zeile fest - eine Zusammenfassung ohne nachvollziehbare Einzelzeilen
 * waere bei 900 Kontakten nicht pruefbar.
 */
export interface ImportSummary {
  total: number;
  created: number;
  enriched: number;
  skipped: number;
  errors: number;
  rows: ImportRowResult[];
}

/**
 * Weitergereicht, damit die uebrigen Import-Module ihre Typen aus einer Quelle
 * beziehen koennen und nicht teils hier, teils aus lib/types.ts importieren.
 */
export type { NewContactInput };
