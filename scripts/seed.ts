import { DB_PATH, closeDb, withTransaction } from '../lib/db';
import {
  addConnection,
  addNeed,
  addNote,
  addOffer,
  addTagToContact,
  createContact,
  deleteContact,
  listConnections,
  listContacts,
  normalizePersonName,
  resolveNeed,
  resolveOffer,
} from '../lib/queries';
import {
  CONTACT_STATUSES,
  type ContactStatus,
  type Role,
  type Source,
  type Stage,
} from '../lib/constants';

/**
 * Beispieldaten für Mutuals.
 *
 * Zweck: die Oberfläche lässt sich ohne echten LinkedIn-Import ausprobieren.
 * Angelegt wird ausschließlich über die Funktionen aus lib/queries.ts - in
 * diesem Skript steht bewusst kein SQL.
 *
 * Aufruf:
 *   npm run seed             Kontakte anlegen, vorhandene überspringen
 *   npm run seed -- --reset  vorher die geseedeten Kontakte entfernen
 *
 * Idempotenz: erkannt wird ein bereits vorhandener Kontakt an Name und Firma
 * (beide normalisiert). Ein zweiter Lauf legt deshalb nichts doppelt an.
 */

// ---------------------------------------------------------------------------
// Form der Beispieldaten
// ---------------------------------------------------------------------------

/** Ein Need oder Offer. resolved === true heißt: erledigt, aber sichtbar. */
interface SeedItem {
  text: string;
  resolved?: boolean;
}

interface SeedNote {
  body: string;
  /** YYYY-MM-DD, immer in der Vergangenheit. */
  occurredOn: string;
}

interface SeedContact {
  name: string;
  role: Role;
  company: string | null;
  title: string | null;
  city: string;
  country: string;
  status: ContactStatus;
  stage: Stage;
  source: Source;
  email?: string;
  phone?: string;
  linkedinUrl?: string;
  birthday?: string;
  howWeMet?: string;
  /** 1..5. Nicht gesetzt heißt NULL in der Datenbank. */
  closeness?: number;
  /** YYYY-MM-DD. Notizen können den Wert nach vorne ziehen. */
  lastContactAt?: string;
  tags: string[];
  needs: SeedItem[];
  offers: SeedItem[];
  notes: SeedNote[];
}

/** Verbindung zwischen zwei Kontakten, benannt über die Namen oben. */
interface SeedConnection {
  a: string;
  b: string;
  note: string;
}

// ---------------------------------------------------------------------------
// Die Kontakte
// ---------------------------------------------------------------------------

/**
 * Drei Paare sind absichtlich so gebaut, dass find_matches sie findet:
 *   Lena Brandhoff (Need: Angel für Seed-Runde)  -> Paul Wenninger (Offer: Angel-Tickets)
 *   Jonas Kreitmayr (Need: Senior-Backend)       -> Mira Sandberg (Offer: vermittelt genau die)
 *   Sofia Almeida (Need: Fertigung Kleinserien)  -> Tomáš Beran (Offer: CNC-Fertigung Kleinserien)
 * Zusätzlich passt Ravi Menon (Need: Zahlungsverkehr) auf Nele Vos (Offer: Zahlungsverkehr).
 */
const SEED_CONTACTS: readonly SeedContact[] = [
  {
    name: 'Paul Wenninger',
    role: 'investor',
    company: 'Wenninger Ventures',
    title: 'Business Angel',
    city: 'München',
    country: 'Deutschland',
    status: 'active',
    stage: 'close',
    source: 'manual',
    email: 'paul@wenninger.vc',
    phone: '+49 89 4410233',
    linkedinUrl: 'https://www.linkedin.com/in/paulwenninger/',
    birthday: '1974-03-09',
    howWeMet: 'Auf dem Nachmittag von Bits & Pretzels vorgestellt worden',
    closeness: 5,
    lastContactAt: '2026-08-04',
    tags: ['healthtech', 'biotech', 'fundraising'],
    needs: [{ text: 'Suche Deal-Flow in HealthTech außerhalb der üblichen Berliner Runden' }],
    offers: [
      { text: 'Investiere als Business Angel in HealthTech, Tickets 100-500k' },
      { text: 'Stelle Kontakt zu Klinikverbünden in Bayern her' },
    ],
    notes: [
      {
        body: 'Kaffee in Schwabing. Will dieses Jahr noch zwei HealthTech-Deals machen, am liebsten mit klinischer Validierung.',
        occurredOn: '2026-08-04',
      },
      {
        body: 'Hat gefragt, ob ich jemanden mit CE-Erfahrung kenne.',
        occurredOn: '2026-06-11',
      },
    ],
  },
  {
    name: 'Lena Brandhoff',
    role: 'founder',
    company: 'Cardio Loop',
    title: 'CEO',
    city: 'München',
    country: 'Deutschland',
    status: 'active',
    stage: 'in_touch',
    source: 'manual',
    email: 'lena@cardioloop.de',
    linkedinUrl: 'https://www.linkedin.com/in/lenabrandhoff/',
    howWeMet: 'Nach ihrem Pitch beim Munich Health Summit angesprochen',
    closeness: 4,
    lastContactAt: '2026-08-19',
    tags: ['healthtech', 'fundraising'],
    needs: [
      { text: 'Suche Angel-Investor für die Seed-Runde in HealthTech' },
      { text: 'Brauche eine Empfehlung für eine Patentanwältin', resolved: true },
    ],
    offers: [
      { text: 'Kann Intros zu Chefärzten in bayerischen Kliniken geben' },
      { text: 'Teile unsere Vorlage für den MDR-Zulassungsprozess', resolved: true },
    ],
    notes: [
      {
        body: 'Runde ist zur Hälfte gezeichnet. Es fehlt ein Angel, der den Klinikvertrieb versteht.',
        occurredOn: '2026-08-19',
      },
    ],
  },
  {
    name: 'Sofia Almeida',
    role: 'founder',
    company: 'Nordwind Robotics',
    title: 'CTO',
    city: 'Lissabon',
    country: 'Portugal',
    status: 'active',
    stage: 'reached_out',
    source: 'manual',
    email: 'sofia@nordwind.io',
    lastContactAt: '2026-07-02',
    tags: ['hardware', 'hiring'],
    needs: [{ text: 'Suche Fertigung für Kleinserien-Sensorik in Europa, kleine Losgrößen' }],
    offers: [{ text: 'Gebe Einblick in unsere Lieferkette für Leiterplatten' }],
    notes: [],
  },
  {
    name: 'Tomáš Beran',
    role: 'operator',
    company: 'Beran Precision',
    title: 'Werksleiter',
    city: 'Prag',
    country: 'Tschechien',
    status: 'active',
    stage: 'in_touch',
    source: 'manual',
    email: 't.beran@beranprecision.cz',
    closeness: 3,
    lastContactAt: '2026-05-28',
    tags: ['hardware'],
    needs: [{ text: 'Suche Zugang zu Medizintechnik-Kunden im DACH-Raum' }],
    offers: [
      { text: 'Biete CNC-Fertigung und Montage von Kleinserien-Sensorik, eigene Linie in Tschechien' },
    ],
    notes: [
      {
        body: 'Führung durch die Halle in Prag. Zwei Linien sind ab Herbst frei.',
        occurredOn: '2026-05-28',
      },
    ],
  },
  {
    name: 'Mira Sandberg',
    role: 'operator',
    company: 'Northlight Talent',
    title: 'Head of Talent',
    city: 'Stockholm',
    country: 'Schweden',
    status: 'active',
    stage: 'in_touch',
    source: 'manual',
    email: 'mira@northlight.se',
    closeness: 3,
    lastContactAt: '2026-07-15',
    tags: ['hiring', 'design'],
    needs: [{ text: 'Suche ein gutes Tool für strukturierte Interview-Notizen' }],
    offers: [
      { text: 'Vermittle Senior-Backend-Entwickler aus meinem Recruiting-Netzwerk' },
      { text: 'Lese Stellenausschreibungen gegen', resolved: true },
    ],
    notes: [
      {
        body: 'Kurzer Call. Hat drei Backend-Leute in der Pipeline, die im Herbst frei werden.',
        occurredOn: '2026-07-15',
      },
    ],
  },
  {
    name: 'Jonas Kreitmayr',
    role: 'founder',
    company: 'Fluxwerk',
    title: 'Gründer',
    city: 'Berlin',
    country: 'Deutschland',
    status: 'active',
    stage: 'reached_out',
    source: 'manual',
    email: 'jonas@fluxwerk.de',
    linkedinUrl: 'https://www.linkedin.com/in/jonaskreitmayr/',
    tags: ['hiring', 'energy'],
    needs: [
      { text: 'Suche einen Senior-Backend-Entwickler für das Plattform-Team' },
      { text: 'Brauche Feedback zum Pricing-Modell', resolved: true },
    ],
    offers: [{ text: 'Teile unseren Datensatz zu Netzentgelten' }],
    notes: [],
  },
  {
    name: 'Anke Roeder',
    role: 'other',
    company: 'Universitätsklinikum Hamburg',
    title: 'Oberärztin Kardiologie',
    city: 'Hamburg',
    country: 'Deutschland',
    status: 'active',
    stage: 'new',
    source: 'manual',
    howWeMet: 'Sitznachbarin auf dem Flug nach Kopenhagen',
    tags: ['healthtech'],
    needs: [],
    offers: [{ text: 'Kann klinische Studiendesigns gegenlesen' }],
    notes: [],
  },
  {
    name: 'Ravi Menon',
    role: 'investor',
    company: 'Kestrel Capital',
    title: 'Principal',
    city: 'London',
    country: 'Vereinigtes Königreich',
    status: 'active',
    stage: 'in_touch',
    source: 'manual',
    email: 'ravi.menon@kestrel.co.uk',
    closeness: 3,
    lastContactAt: '2026-06-30',
    tags: ['fintech', 'fundraising'],
    needs: [{ text: 'Suche Gründerinnen im Bereich Zahlungsverkehr' }],
    offers: [{ text: 'Frühphasen-Investments in Fintech, Tickets bis 250k' }],
    notes: [],
  },
  {
    name: 'Nele Vos',
    role: 'operator',
    company: 'Adyen',
    title: 'Product Lead Payments',
    city: 'Amsterdam',
    country: 'Niederlande',
    status: 'active',
    stage: 'close',
    source: 'manual',
    email: 'nele.vos@adyen.example',
    closeness: 4,
    lastContactAt: '2026-08-12',
    tags: ['fintech', 'design'],
    needs: [{ text: 'Suche eine Mentorin für den Schritt in eine C-Level-Rolle' }],
    offers: [
      { text: 'Kann Zahlungsverkehr-Architektur reviewen' },
      { text: 'Habe zwei Praktikumsplätze vermittelt', resolved: true },
    ],
    notes: [
      {
        body: 'Abendessen in Amsterdam. Will in zwei Jahren CPO sein und sucht jemanden, der den Weg schon gegangen ist.',
        occurredOn: '2026-08-12',
      },
    ],
  },
  {
    name: 'Elias Trüb',
    role: 'student',
    company: 'ETH Zürich',
    title: 'Doktorand Machine Learning',
    city: 'Zürich',
    country: 'Schweiz',
    status: 'active',
    stage: 'new',
    source: 'manual',
    email: 'elias.trueb@ethz.example',
    closeness: 2,
    tags: ['llm-research', 'biotech'],
    needs: [{ text: 'Suche ein Praktikum im Bereich LLM-Evaluation' }],
    offers: [{ text: 'Kann Paper zu Retrieval-Verfahren zusammenfassen' }],
    notes: [],
  },
  {
    name: 'Yara Haddad',
    role: 'community',
    company: 'Climate Circle Berlin',
    title: 'Community Lead',
    city: 'Berlin',
    country: 'Deutschland',
    status: 'active',
    stage: 'in_touch',
    source: 'manual',
    email: 'yara@climatecircle.berlin',
    closeness: 4,
    lastContactAt: '2026-07-27',
    tags: ['climate', 'energy'],
    needs: [
      { text: 'Suche Speaker für das Meetup im Oktober' },
      { text: 'Suche eine Location für 120 Leute', resolved: true },
    ],
    offers: [{ text: 'Bringe Leute aus der Berliner Climate-Szene zusammen' }],
    notes: [
      {
        body: 'Plant für Oktober ein Meetup zu Wärmenetzen und hat nach Kontakten gefragt.',
        occurredOn: '2026-07-27',
      },
    ],
  },
  {
    name: 'Marek Nowak',
    role: 'operator',
    company: 'Enerlyt',
    title: 'Head of Grid Analytics',
    city: 'Wien',
    country: 'Österreich',
    status: 'imported',
    stage: 'new',
    source: 'linkedin',
    linkedinUrl: 'https://www.linkedin.com/in/mareknowak/',
    tags: ['energy'],
    needs: [],
    offers: [],
    notes: [],
  },
  {
    name: 'Charlotte Diehl',
    role: 'founder',
    company: 'Solvia Bio',
    title: 'Co-Founderin',
    city: 'Zürich',
    country: 'Schweiz',
    status: 'active',
    stage: 'close',
    source: 'manual',
    email: 'charlotte@solvia.bio',
    closeness: 5,
    lastContactAt: '2026-08-21',
    tags: ['biotech', 'fundraising'],
    needs: [{ text: 'Suche eine erfahrene Regulatory-Beraterin für die FDA-Einreichung' }],
    offers: [
      { text: 'Biete Laborzeit in unserem BSL-2-Labor' },
      { text: 'Habe eine Vorlage für Term Sheets', resolved: true },
    ],
    notes: [
      {
        body: 'Serie A ist durch. Sucht jetzt jemanden, der eine FDA-Einreichung schon einmal begleitet hat.',
        occurredOn: '2026-08-21',
      },
    ],
  },
  {
    name: 'Ben Okoro',
    role: 'other',
    company: 'Freiberuflich',
    title: 'Illustrator',
    city: 'London',
    country: 'Vereinigtes Königreich',
    status: 'active',
    stage: 'dormant',
    source: 'manual',
    email: 'ben@okoro.draws',
    closeness: 1,
    lastContactAt: '2025-11-03',
    tags: ['design'],
    needs: [],
    offers: [{ text: 'Zeichne Illustrationen für Pitch-Decks' }],
    notes: [
      {
        body: 'Lange nichts gehört. Der letzte Auftrag war das Deck für Fluxwerk.',
        occurredOn: '2025-11-03',
      },
    ],
  },
  {
    name: 'Katharina Loibl',
    role: 'investor',
    company: 'Hochsauerland Family Office',
    title: 'Investment Managerin',
    city: 'München',
    country: 'Deutschland',
    status: 'active',
    stage: 'reached_out',
    source: 'manual',
    email: 'k.loibl@hsr-office.de',
    tags: ['energy', 'fundraising'],
    needs: [{ text: 'Suche Co-Investoren für ein Wärmenetz-Projekt' }],
    offers: [{ text: 'Wir investieren in Energie-Infrastruktur ab zwei Millionen' }],
    notes: [],
  },
  {
    name: 'Hendrik Baas',
    role: 'operator',
    company: 'Van Oord',
    title: 'Projektleiter Offshore',
    city: 'Amsterdam',
    country: 'Niederlande',
    status: 'imported',
    stage: 'new',
    source: 'linkedin',
    linkedinUrl: 'https://www.linkedin.com/in/hendrikbaas/',
    tags: ['energy'],
    needs: [],
    offers: [],
    notes: [],
  },
  {
    name: 'Priya Raghavan',
    role: 'founder',
    company: 'Anvil Health',
    title: 'CEO',
    city: 'London',
    country: 'Vereinigtes Königreich',
    status: 'imported',
    stage: 'new',
    source: 'csv',
    tags: ['healthtech'],
    needs: [{ text: 'Suche Klinikpartner für eine Pilotstudie in Deutschland' }],
    offers: [],
    notes: [],
  },
  {
    name: 'Gustav Lindqvist',
    role: 'student',
    company: 'KTH Stockholm',
    title: 'Masterand Klimaphysik',
    city: 'Stockholm',
    country: 'Schweden',
    status: 'active',
    stage: 'new',
    source: 'manual',
    email: 'gustav.lindqvist@kth.example',
    closeness: 2,
    tags: ['llm-research', 'climate'],
    needs: [{ text: 'Suche eine Werkstudentenstelle im Bereich Klimamodellierung' }],
    offers: [{ text: 'Helfe bei Datenaufbereitung in Python' }],
    notes: [],
  },
  {
    name: 'Fabienne Meyer',
    role: 'community',
    company: 'Design Systems Meetup Paris',
    title: 'Organisatorin',
    city: 'Paris',
    country: 'Frankreich',
    status: 'active',
    stage: 'reached_out',
    source: 'manual',
    email: 'fabienne@dsmeetup.paris',
    closeness: 3,
    tags: ['design', 'hiring'],
    needs: [
      { text: 'Suche einen Sponsor für das nächste Meetup' },
      { text: 'Suche Räume für den Dezember-Termin', resolved: true },
    ],
    offers: [{ text: 'Kann Design-Systems-Leute aus dem Meetup vermitteln' }],
    notes: [],
  },
  {
    name: 'Oskar Reinhardt',
    role: 'other',
    company: 'Reinhardt und Söhne',
    title: 'Geschäftsführer',
    city: 'Hamburg',
    country: 'Deutschland',
    status: 'archived',
    stage: 'dormant',
    source: 'manual',
    closeness: 2,
    lastContactAt: '2025-04-16',
    tags: ['hardware'],
    needs: [],
    offers: [{ text: 'Konnte Kontakte zu Zulieferern im Norden geben', resolved: true }],
    notes: [
      {
        body: 'Die Firma wurde verkauft, er ist im Ruhestand. Deshalb archiviert.',
        occurredOn: '2025-04-16',
      },
    ],
  },
  {
    name: 'Ines Fabri',
    role: 'community',
    company: 'Founders Brunch Wien',
    title: 'Gastgeberin',
    city: 'Wien',
    country: 'Österreich',
    status: 'archived',
    stage: 'dormant',
    source: 'manual',
    tags: ['fundraising'],
    needs: [],
    offers: [],
    notes: [],
  },
];

const SEED_CONNECTIONS: readonly SeedConnection[] = [
  { a: 'Paul Wenninger', b: 'Katharina Loibl', note: 'Sitzen beide im Beirat von BayStartUP.' },
  { a: 'Mira Sandberg', b: 'Fabienne Meyer', note: 'Kennen sich vom Design-Systems-Meetup.' },
  { a: 'Nele Vos', b: 'Ravi Menon', note: 'Waren zusammen auf der Money20/20.' },
  { a: 'Yara Haddad', b: 'Gustav Lindqvist', note: 'Über die Mailingliste des Climate Circle.' },
  { a: 'Sofia Almeida', b: 'Elias Trüb', note: 'Haben zusammen an der ETH studiert.' },
  { a: 'Lena Brandhoff', b: 'Anke Roeder', note: 'Anke berät Cardio Loop klinisch.' },
];

// ---------------------------------------------------------------------------
// Wiedererkennung vorhandener Kontakte
// ---------------------------------------------------------------------------

/**
 * Schlüssel aus Name und Firma, beide über normalizePersonName vereinheitlicht
 * (klein, ohne Akzente, ohne Satzzeichen). "Nele Vos"/"Adyen" und
 * "nele  vos"/"adyen." landen damit auf demselben Schlüssel.
 */
function contactKey(name: string, company: string | null): string {
  return `${normalizePersonName(name)}::${normalizePersonName(company ?? '')}`;
}

/**
 * Alle Kontakte der Datenbank nach Schlüssel gruppiert. Gelesen wird über
 * listContacts je Status, weil der Standardfilter archivierte Kontakte
 * ausblendet - die sollen hier aber mitgezählt werden.
 */
function loadExistingIds(): Map<string, number[]> {
  const byKey = new Map<string, number[]>();
  for (const status of CONTACT_STATUSES) {
    for (const row of listContacts({ status })) {
      const key = contactKey(row.name, row.company);
      const ids = byKey.get(key);
      if (ids === undefined) {
        byKey.set(key, [row.id]);
      } else {
        ids.push(row.id);
      }
    }
  }
  return byKey;
}

// ---------------------------------------------------------------------------
// Schreiben
// ---------------------------------------------------------------------------

interface Counters {
  contacts: number;
  needs: number;
  offers: number;
  tags: number;
  notes: number;
  connections: number;
}

/**
 * Legt einen Kontakt mit allem an, was an ihm hängt. Die einzelnen Funktionen
 * aus queries.ts sind jede für sich transaktional; die Klammer hier sorgt
 * dafür, dass ein Kontakt entweder vollständig oder gar nicht entsteht.
 */
function createSeedContact(seed: SeedContact, counters: Counters): void {
  withTransaction(() => {
    const contact = createContact({
      name: seed.name,
      status: seed.status,
      stage: seed.stage,
      role: seed.role,
      company: seed.company,
      title: seed.title,
      city: seed.city,
      country: seed.country,
      email: seed.email ?? null,
      phone: seed.phone ?? null,
      linkedin_url: seed.linkedinUrl ?? null,
      birthday: seed.birthday ?? null,
      how_we_met: seed.howWeMet ?? null,
      closeness: seed.closeness ?? null,
      source: seed.source,
      last_contact_at: seed.lastContactAt ?? null,
    });

    for (const tagName of seed.tags) {
      addTagToContact(contact.id, tagName);
      counters.tags += 1;
    }

    for (const need of seed.needs) {
      const created = addNeed(contact.id, need.text);
      if (need.resolved === true) {
        resolveNeed(created.id);
      }
      counters.needs += 1;
    }

    for (const offer of seed.offers) {
      const created = addOffer(contact.id, offer.text);
      if (offer.resolved === true) {
        resolveOffer(created.id);
      }
      counters.offers += 1;
    }

    // addNote zieht last_contact_at nach vorne, wenn die Notiz jünger ist.
    // Die Notizdaten sind deshalb auf lastContactAt abgestimmt.
    for (const note of seed.notes) {
      addNote(contact.id, note.body, note.occurredOn);
      counters.notes += 1;
    }

    counters.contacts += 1;
  });
}

/**
 * Verbindungen anlegen, nachdem alle Kontakte stehen. addConnection ist bei
 * einem bereits vorhandenen Paar ein No-Op beziehungsweise aktualisiert nur
 * die Notiz - ein zweiter Seed-Lauf erzeugt hier also keine Dubletten.
 */
function createSeedConnections(counters: Counters): void {
  const byKey = loadExistingIds();
  const idOf = (name: string): number | null => {
    const seed = SEED_CONTACTS.find((candidate) => candidate.name === name);
    if (seed === undefined) {
      throw new Error(`Die Verbindung verweist auf "${name}", der nicht in den Beispieldaten steht.`);
    }
    const ids = byKey.get(contactKey(seed.name, seed.company));
    return ids === undefined || ids.length === 0 ? null : (ids[0] ?? null);
  };

  withTransaction(() => {
    for (const connection of SEED_CONNECTIONS) {
      const aId = idOf(connection.a);
      const bId = idOf(connection.b);
      if (aId === null || bId === null) {
        continue;
      }
      const known = listConnections(aId).some(
        (row) => row.contact_a_id === bId || row.contact_b_id === bId,
      );
      addConnection(aId, bId, connection.note);
      if (!known) {
        counters.connections += 1;
      }
    }
  });
}

/** Entfernt die geseedeten Kontakte samt allem, was an ihnen hängt (Cascade). */
function removeSeedContacts(): number {
  const byKey = loadExistingIds();
  const ids: number[] = [];
  for (const seed of SEED_CONTACTS) {
    ids.push(...(byKey.get(contactKey(seed.name, seed.company)) ?? []));
  }

  withTransaction(() => {
    for (const id of ids) {
      deleteContact(id);
    }
  });

  return ids.length;
}

// ---------------------------------------------------------------------------
// Einstieg
// ---------------------------------------------------------------------------

interface Options {
  reset: boolean;
  help: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { reset: false, help: false };
  for (const arg of argv) {
    if (arg === '--reset') {
      options.reset = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unbekanntes Argument: ${arg}. Erlaubt sind --reset und --help.`);
    }
  }
  return options;
}

function printUsage(): void {
  console.log('Beispieldaten für Mutuals.');
  console.log('');
  console.log('  npm run seed             legt fehlende Kontakte an, vorhandene bleiben unberührt');
  console.log('  npm run seed -- --reset  entfernt die geseedeten Kontakte vorher');
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  console.log(`Datenbank: ${DB_PATH}`);
  console.log('');

  if (options.reset) {
    const removed = removeSeedContacts();
    console.log(`Reset: ${removed} geseedete Kontakte entfernt.`);
    console.log('');
  }

  const existing = loadExistingIds();
  const counters: Counters = { contacts: 0, needs: 0, offers: 0, tags: 0, notes: 0, connections: 0 };
  let skipped = 0;

  for (const seed of SEED_CONTACTS) {
    const key = contactKey(seed.name, seed.company);
    if (existing.has(key)) {
      skipped += 1;
      continue;
    }
    createSeedContact(seed, counters);
  }

  createSeedConnections(counters);

  console.log(
    `Zusammenfassung: ${counters.contacts} angelegt, ${skipped} übersprungen ` +
      `(${SEED_CONTACTS.length} Kontakte in den Beispieldaten).`,
  );
  console.log(
    `Dazu: ${counters.needs} Needs, ${counters.offers} Offers, ${counters.tags} Tags, ` +
      `${counters.notes} Notizen, ${counters.connections} Verbindungen.`,
  );
  if (counters.contacts === 0 && skipped > 0) {
    console.log('Es war nichts zu tun. Mit --reset lassen sich die Beispieldaten neu aufbauen.');
  }
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error('');
  console.error(`Fehler: ${message}`);
  process.exitCode = 1;
} finally {
  closeDb();
}
