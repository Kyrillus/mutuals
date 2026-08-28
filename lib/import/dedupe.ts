/**
 * Dublettenerkennung des Imports als In-Memory-Index.
 *
 * Die Kaskade ist dreistufig und die Reihenfolge ist bindend:
 *   1. linkedin_url  (kanonisiert)
 *   2. email         (normalisiert)
 *   3. Name          (normalisiert: klein, ohne Diakritika, Whitespace gefaltet)
 * Der erste Treffer gewinnt, matchedBy sagt, welche Stufe gegriffen hat. Eine
 * spaetere Stufe wird nur befragt, wenn die frueheren nicht getroffen haben -
 * nicht schon dann, wenn der Wert der frueheren Stufe fehlt.
 *
 * Drei Eigenschaften sind hier die eigentliche Arbeit:
 *
 * 1. Leere Werte matchen NIE. Im echten LinkedIn-Export hat die Mehrheit der
 *    Zeilen keine E-Mail-Adresse. Wuerde der leere String als Schluessel in die
 *    Map wandern, waeren alle diese Kontakte ueber Stufe 2 "dieselbe Person"
 *    und der Import wuerde 30 Zeilen in eine einzige zusammenfuehren. Deshalb
 *    landet ein leerer Schluessel weder beim Aufbau noch beim Nachschlagen in
 *    einer Map.
 *
 * 2. Der Index waechst waehrend des Imports mit (add). Zwei Zeilen DERSELBEN
 *    Datei koennen Dubletten voneinander sein. Kennt der Index nur den
 *    Datenbankstand von vor dem Import, werden beide angelegt - und ein
 *    zweiter Lauf derselben Datei findet dann zwei Kandidaten vor. Der
 *    Aufrufer meldet deshalb jeden neu angelegten Kontakt sofort ueber add()
 *    zurueck; ebenso einen ergaenzten, damit dessen frisch gefuellte Felder ab
 *    sofort als Schluessel zur Verfuegung stehen.
 *
 * 3. Ein GEGENBEWEIS schlaegt den schwachen Namenstreffer. Dass Stufe 1 nicht
 *    getroffen hat, heisst zweierlei: entweder hatte eine der beiden Seiten
 *    keine Profil-URL (dann sagt die Stufe nichts aus), oder beide hatten eine
 *    und sie waren VERSCHIEDEN. Im zweiten Fall ist bewiesen, dass es zwei
 *    verschiedene Menschen sind - dann darf der gleiche Name sie nicht doch
 *    noch zusammenfuehren. Ohne diese Regel werden
 *    /in/anna-schmidt-berlin und /in/anna-schmidt-muenchen ein Kontakt, und in
 *    einem Export mit 900 Verbindungen sind gleiche Namen der Normalfall.
 *    Dasselbe gilt fuer zwei verschiedene E-Mail-Adressen.
 */

import { z } from 'zod';

import { looksLikeEmail, normalizeEmail, normalizeLinkedinUrl, normalizeName } from './normalize';

export interface DedupeMatch {
  id: number;
  matchedBy: 'linkedin_url' | 'email' | 'name';
}

/**
 * Was nachgeschlagen wird. Die Felder sind optional UND nullable, weil die
 * Zeilendaten des Imports aus Partial<NewContactInput> stammen und dort ein
 * leeres Feld sowohl undefined als auch null sein kann. Der Aufrufer soll
 * dafuer kein "?? undefined" schreiben muessen.
 */
export interface DedupeCandidate {
  name?: string | null;
  email?: string | null;
  linkedin_url?: string | null;
}

/** Ein Kontakt, wie er in den Index aufgenommen wird. */
export interface DedupeEntry {
  id: number;
  name: string;
  email: string | null;
  linkedin_url: string | null;
}

export interface DedupeIndex {
  find(c: DedupeCandidate): DedupeMatch | null;
  add(c: DedupeEntry): void;
}

/**
 * Eintraege, die in den Index geschrieben werden, sind validiert - ein
 * kaputter Datensatz wuerde hier keinen sichtbaren Fehler ausloesen, sondern
 * stillschweigend falsche Treffer erzeugen.
 *
 * find() geht bewusst ohne zod: dort wird nichts gespeichert, jeder Wert
 * durchlaeuft ohnehin die Normalisierung, und die Funktion laeuft einmal pro
 * Importzeile.
 */
const dedupeEntrySchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  email: z.string().nullable(),
  linkedin_url: z.string().nullable(),
});

/** Schluessel der Stufe 1, oder '' wenn die Zeile dafuer nichts hergibt. */
function linkedinKey(value: string | null | undefined): string {
  if (typeof value !== 'string') {
    return '';
  }
  return normalizeLinkedinUrl(value);
}

/**
 * Schluessel der Stufe 2, oder '' wenn die Zeile dafuer nichts hergibt.
 *
 * Platzhalter wie 'n/a' oder '-' faellt looksLikeEmail heraus. Waeren sie
 * Schluessel, waeren alle Zeilen mit demselben Platzhalter ueber Stufe 2
 * dieselbe Person - derselbe Fehler wie beim leeren Wert, nur schwerer zu
 * sehen.
 */
function emailKey(value: string | null | undefined): string {
  if (typeof value !== 'string') {
    return '';
  }
  const key = normalizeEmail(value);
  return looksLikeEmail(key) ? key : '';
}

/** Schluessel der Stufe 3, oder '' wenn die Zeile dafuer nichts hergibt. */
function nameKey(value: string | null | undefined): string {
  if (typeof value !== 'string') {
    return '';
  }
  return normalizeName(value);
}

/**
 * Baut den Index aus dem Datenbankstand vor dem Import. Die Liste kommt aus
 * getAllContactsForDedup().
 */
export function buildDedupeIndex(existing: readonly DedupeEntry[]): DedupeIndex {
  const byLinkedinUrl = new Map<string, number>();
  const byEmail = new Map<string, number>();

  /**
   * Die Namensstufe haelt ALLE ids zu einem Namen, nicht nur die kleinste.
   * Grund ist der Gegenbeweis weiter unten: er gilt je Kontakt, nicht je Name.
   * Steht 'Anna Schmidt' zweimal in der Datenbank und widerspricht nur eine
   * der beiden der Importzeile, soll die andere trotzdem gefunden werden
   * koennen. Die Liste ist aufsteigend sortiert, damit die Auswahl
   * deterministisch bleibt.
   */
  const byName = new Map<string, number[]>();

  /** Die Schluessel je Kontakt - Grundlage der Gegenbeweis-Pruefung. */
  const keysById = new Map<number, { linkedin: string; email: string }>();

  /**
   * Mehrdeutigkeit: liegt zu einem Schluessel schon ein Kontakt vor (zwei
   * bestehende Kontakte mit demselben normalisierten Namen sind der
   * Normalfall - 'Anna Schmidt' gibt es zweimal), gewinnt die KLEINSTE ID.
   * Das ist der aelteste Datensatz und damit der, an dem die laengste
   * Historie haengt. Wichtiger als die Begruendung ist die Eigenschaft: die
   * Regel ist deterministisch, also haengt das Ergebnis eines Imports nicht
   * davon ab, in welcher Reihenfolge die Kontakte in den Index gelaufen sind.
   * Der zweite Kontakt bleibt unangetastet; zusammenfuehren ist eine
   * Entscheidung fuer den Menschen, nicht fuer den Import.
   */
  function remember(map: Map<string, number>, key: string, id: number): void {
    if (key === '') {
      return;
    }
    const known = map.get(key);
    if (known === undefined || id < known) {
      map.set(key, id);
    }
  }

  /** Wie remember, nur dass alle Kandidaten aufsteigend erhalten bleiben. */
  function rememberName(key: string, id: number): void {
    if (key === '') {
      return;
    }
    const ids = byName.get(key);
    if (ids === undefined) {
      byName.set(key, [id]);
      return;
    }
    if (ids.includes(id)) {
      return;
    }
    // Einsortieren statt anhaengen: die Liste wird in find der Reihe nach
    // abgelaufen, und die kleinste id soll weiterhin zuerst drankommen.
    const position = ids.findIndex((known) => known > id);
    if (position === -1) {
      ids.push(id);
    } else {
      ids.splice(position, 0, id);
    }
  }

  function add(entry: DedupeEntry): void {
    const parsed = dedupeEntrySchema.parse(entry);
    const linkedin = linkedinKey(parsed.linkedin_url);
    const email = emailKey(parsed.email);

    remember(byLinkedinUrl, linkedin, parsed.id);
    remember(byEmail, email, parsed.id);
    rememberName(nameKey(parsed.name), parsed.id);

    // Ein ergaenzter Kontakt wird ein zweites Mal aufgenommen und bringt dann
    // frisch gefuellte Felder mit. Ein einmal bekannter Schluessel darf dabei
    // nicht verloren gehen (er stuende sonst als Gegenbeweis nicht mehr zur
    // Verfuegung), ein neuer soll dazukommen.
    const known = keysById.get(parsed.id);
    keysById.set(parsed.id, {
      linkedin: linkedin !== '' ? linkedin : (known?.linkedin ?? ''),
      email: email !== '' ? email : (known?.email ?? ''),
    });
  }

  /**
   * Ist bewiesen, dass Kandidat und Kontakt zwei verschiedene Menschen sind?
   *
   * Bewiesen heisst: beide Seiten tragen denselben Schluesseltyp mit einem
   * belastbaren, aber verschiedenen Wert. Fehlt der Wert auf einer Seite, sagt
   * er nichts aus - dann ist das kein Gegenbeweis, sondern nur eine Luecke.
   */
  function contradicts(id: number, candidateLinkedin: string, candidateEmail: string): boolean {
    const keys = keysById.get(id);
    if (keys === undefined) {
      return false;
    }
    const urlConflict =
      candidateLinkedin !== '' && keys.linkedin !== '' && candidateLinkedin !== keys.linkedin;
    const emailConflict =
      candidateEmail !== '' && keys.email !== '' && candidateEmail !== keys.email;
    return urlConflict || emailConflict;
  }

  function find(candidate: DedupeCandidate): DedupeMatch | null {
    const linkedin = linkedinKey(candidate.linkedin_url);
    if (linkedin !== '') {
      const id = byLinkedinUrl.get(linkedin);
      if (id !== undefined) {
        return { id, matchedBy: 'linkedin_url' };
      }
    }

    const email = emailKey(candidate.email);
    if (email !== '') {
      const id = byEmail.get(email);
      if (id !== undefined) {
        return { id, matchedBy: 'email' };
      }
    }

    const name = nameKey(candidate.name);
    if (name !== '') {
      for (const id of byName.get(name) ?? []) {
        // Hier greift der Gegenbeweis: gleicher Name, aber nachweislich eine
        // andere Person. Lieber ein zweiter Kontakt (den ein Mensch bei Bedarf
        // zusammenfuehren kann) als eine Verschmelzung, die niemand mehr
        // rueckgaengig macht.
        if (!contradicts(id, linkedin, email)) {
          return { id, matchedBy: 'name' };
        }
      }
    }

    return null;
  }

  for (const entry of existing) {
    add(entry);
  }

  return { find, add };
}
