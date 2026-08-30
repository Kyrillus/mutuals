/**
 * Zeilentypen der Datenbank und die davon abgeleiteten Ein-/Ausgabetypen.
 *
 * Die Feldnamen entsprechen exakt den Spaltennamen (snake_case), damit Rows aus
 * better-sqlite3 ohne Umbenennung als diese Typen durchgereicht werden können.
 * Nullable Spalten sind bewusst `| null` und nicht optional: eine Zeile aus der
 * Datenbank hat immer alle Spalten, nur eben teils mit dem Wert null.
 */

import type { ContactStatus, Role, Source, Stage } from './constants';

export interface Contact {
  id: number;
  name: string;
  status: ContactStatus;
  stage: Stage;
  role: Role | null;
  company: string | null;
  /** Freitext, z.B. "Head of Engineering". */
  title: string | null;
  city: string | null;
  country: string | null;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
  /** ISO-Datum, Jahr optional - auch '--03-14' ist gültig. */
  birthday: string | null;
  how_we_met: string | null;
  /** 1..5, siehe CLOSENESS_MIN / CLOSENESS_MAX. */
  closeness: number | null;
  source: Source;
  last_contact_at: string | null;
  created_at: string;
  updated_at: string;
}

/** needs und offers haben identische Spalten, liegen aber in getrennten Tabellen. */
export interface ContactItem {
  id: number;
  contact_id: number;
  text: string;
  created_at: string;
  /** NULL = offen. */
  resolved_at: string | null;
}

/** Was die Person sucht. */
export type Need = ContactItem;

/** Was die Person bieten kann. */
export type Offer = ContactItem;

export interface Note {
  id: number;
  contact_id: number;
  body: string;
  /** Datum des Treffens oder Gesprächs, nicht der Erfassung. */
  occurred_on: string | null;
  created_at: string;
}

export interface Tag {
  id: number;
  name: string;
}

export interface Connection {
  id: number;
  /** Immer der kleinere der beiden Werte, siehe CHECK-Constraint. */
  contact_a_id: number;
  contact_b_id: number;
  note: string | null;
  created_at: string;
}

/**
 * Eine Zeile der Listenansicht: Kontakt plus die beiden Werte, die in der
 * Tabelle stehen, aber nicht am Kontakt hängen. tags sind hier nur die Namen,
 * weil die Liste keine Tag-IDs braucht.
 */
export type ContactListRow = Contact & {
  open_needs_count: number;
  tags: string[];
};

/**
 * Ein Kontakt mit allem, was daran hängt. notes ist optional, weil Notizen die
 * private Schicht sind und nur auf ausdrückliche Anforderung mitgeliefert
 * werden (MCP: include_notes).
 */
export type ContactDetail = Contact & {
  needs: Need[];
  offers: Offer[];
  tags: Tag[];
  notes?: Note[];
};

/** Der konkrete Beleg, auf dem eine Übereinstimmung beruht. */
export interface MatchEvidence {
  kind: 'need' | 'offer' | 'tag' | 'profile';
  /** Der gefundene Text, z.B. der Wortlaut des Offers. */
  text: string;
  /** Der Suchbegriff, der darin getroffen hat. */
  term: string;
}

/**
 * Kandidat aus find_matches. Bewusst ohne Score: das Tool liefert Belege, die
 * Bewertung macht das aufrufende Modell beziehungsweise der Mensch.
 */
export interface MatchCandidate {
  contact: Contact;
  matched_on: MatchEvidence[];
}

/**
 * Schreibbare Spalten. id und updated_at gehören der Query-Schicht;
 * created_at bleibt schreibbar, weil der LinkedIn-Import "Connected On"
 * darauf abbildet.
 */
type WritableContact = Omit<Contact, 'id' | 'updated_at'>;

/** Neuanlage: nur name ist Pflicht, der Rest fällt auf die DB-Defaults zurück. */
export type NewContactInput = { name: string } & Partial<Omit<WritableContact, 'name'>>;

/**
 * Teiländerung eines Kontakts. Nicht gesetzte Felder bleiben unverändert,
 * ein explizites null leert das Feld. created_at ist ausgenommen.
 */
export type ContactPatch = Partial<Omit<WritableContact, 'created_at'>>;

/** Filter der Listenansicht und von search_contacts. */
export interface ContactFilters {
  status?: ContactStatus;
  stage?: Stage;
  role?: Role;
  city?: string;
  /** Tag-Name, nicht die ID. */
  tag?: string;
  hasOpenNeeds?: boolean;
  /** Volltextsuche über den FTS-Index - ohne Notizen. */
  query?: string;
}
