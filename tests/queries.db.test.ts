import { beforeEach, describe, expect, it } from 'vitest';

import {
  NotFoundError,
  addNeed,
  addNote,
  addOffer,
  addTagToContact,
  createContact,
  deleteConnection,
  deleteContact,
  deleteNeed,
  deleteNote,
  findMatches,
  getAllContactsForDedup,
  listContacts,
  listDistinctCities,
  listTagsForContact,
  removeTagFromContact,
  resolveOffer,
  searchContactsFts,
} from '@/lib/queries';
import { withTransaction } from '@/lib/db';

/**
 * Regressionstests der Datenzugriffsschicht gegen eine Wegwerf-Datenbank
 * (Pfad siehe vitest.config.ts). Jeder Block deckt einen Fall ab, der einmal
 * falsch war - die Beschreibung nennt jeweils das Verhalten, nicht die
 * Implementierung.
 */

const NUL = String.fromCharCode(0);

/** Leert die Kontakte (Cascade raeumt Needs, Offers, Notizen, Tags, Verbindungen). */
function resetContacts(): void {
  withTransaction(() => {
    for (const row of getAllContactsForDedup()) {
      deleteContact(row.id);
    }
  });
}

beforeEach(() => {
  resetContacts();
});

describe('listContacts: Suche und Filter greifen gemeinsam', () => {
  it('findet einen Treffer auch dann, wenn die Textsuche allein tausende Zeilen trifft', () => {
    withTransaction(() => {
      for (let i = 0; i < 1200; i += 1) {
        createContact({
          name: `Schmidt Person ${i}`,
          status: 'active',
          stage: i === 1199 ? 'close' : 'new',
          city: i === 1199 ? 'Sonderstadt' : 'Berlin',
        });
      }
    });

    // Die reine Textsuche trifft alle 1200 - der Zusatzfilter genau einen.
    expect(listContacts({ query: 'Schmidt' })).toHaveLength(1200);

    const byStage = listContacts({ query: 'Schmidt', stage: 'close' });
    expect(byStage.map((row) => row.name)).toEqual(['Schmidt Person 1199']);

    const byCity = listContacts({ query: 'Schmidt', city: 'Sonderstadt' });
    expect(byCity.map((row) => row.name)).toEqual(['Schmidt Person 1199']);

    // Gegenprobe: derselbe Kontakt ist auch ohne Suche da, der Index ist sauber.
    expect(listContacts({ stage: 'close' }).map((row) => row.name)).toEqual([
      'Schmidt Person 1199',
    ]);
  });

  it('behaelt ohne angeforderte Sortierung die Relevanzreihenfolge des Index', () => {
    createContact({ name: 'Zeta Konstantin', status: 'active' });
    createContact({ name: 'Alpha Bauer', status: 'active', company: 'Konstantin Konstantin GmbH' });
    createContact({ name: 'Konstantin Mueller', status: 'active', how_we_met: 'Konstantin-Treffen' });

    const rows = listContacts({ query: 'Konstantin' });
    expect(rows).toHaveLength(3);

    // Massstab ist der Index selbst, nicht das Alphabet: die Liste liefert
    // dieselbe bm25-Reihenfolge wie die Volltextsuche.
    expect(rows.map((row) => row.id)).toEqual(searchContactsFts('Konstantin'));
  });

  it('respektiert eine ausdruecklich angeforderte Sortierung', () => {
    createContact({ name: 'Zeta Sucher', status: 'active' });
    createContact({ name: 'Alpha Sucher', status: 'active' });

    const rows = listContacts({ query: 'Sucher' }, { column: 'name', direction: 'asc' });
    expect(rows.map((row) => row.name)).toEqual(['Alpha Sucher', 'Zeta Sucher']);
  });
});

describe('Suchtext: Sonderfaelle stuerzen nicht ab', () => {
  it('vertraegt ein NUL-Zeichen in der Eingabe', () => {
    createContact({ name: 'Abcdef Testperson', status: 'active' });

    expect(() => searchContactsFts(`abc${NUL}def`)).not.toThrow();
    expect(searchContactsFts(`abc${NUL}def`)).toHaveLength(1);
    expect(() => searchContactsFts(`${NUL}abc`)).not.toThrow();
    expect(listContacts({ query: `abc${NUL}def` })).toHaveLength(1);
  });

  it('kappt einen ueberlangen Suchbegriff, statt ihn abzulehnen', () => {
    createContact({ name: 'Aaa Langtext', status: 'active' });

    expect(() => searchContactsFts('a'.repeat(2000))).not.toThrow();
    expect(() => listContacts({ query: 'a'.repeat(2000) })).not.toThrow();
    expect(listContacts({ query: `Langtext ${'x'.repeat(600)}` })).toHaveLength(0);
  });

  it('speichert keine Steuerzeichen, die die Zeile unauffindbar machen wuerden', () => {
    const contact = createContact({ name: `Anna${NUL}Bogus`, status: 'active' });
    expect(contact.name).toBe('AnnaBogus');
    expect(listContacts({ query: 'AnnaBogus' })).toHaveLength(1);
  });
});

describe('city-Filter: Unicode wird gefaltet, nicht nur ASCII', () => {
  beforeEach(() => {
    createContact({ name: 'Muenchner Eins', status: 'active', city: 'München' });
    createContact({ name: 'Muenchner Zwei', status: 'active', city: 'münchen' });
    createContact({ name: 'Muenchner Drei', status: 'active', city: 'MÜNCHEN' });
    createContact({ name: 'Berliner Eins', status: 'active', city: 'Berlin' });
  });

  it('findet alle Schreibweisen derselben Stadt', () => {
    for (const spelling of ['München', 'münchen', 'MÜNCHEN', 'Munchen', 'MUNCHEN']) {
      expect(listContacts({ city: spelling })).toHaveLength(3);
    }
    expect(listContacts({ city: 'BERLIN' })).toHaveLength(1);
  });

  it('zeigt jede Stadt nur einmal im Dropdown', () => {
    const cities = listDistinctCities();
    expect(cities).toHaveLength(2);
    expect(cities.filter((city) => city.toLowerCase().startsWith('m'))).toHaveLength(1);
  });
});

describe('Loeschen meldet, wenn es die Zeile nicht gibt', () => {
  it('wirft NotFoundError statt still nichts zu tun', () => {
    expect(() => deleteContact(999999)).toThrow(NotFoundError);
    expect(() => deleteNote(999999)).toThrow(NotFoundError);
    expect(() => deleteNeed(999999)).toThrow(NotFoundError);
    expect(() => deleteConnection(999999)).toThrow(NotFoundError);
  });

  it('loescht vorhandene Zeilen weiterhin ohne Murren', () => {
    const contact = createContact({ name: 'Loesch Testperson', status: 'active' });
    const need = addNeed(contact.id, 'Ein offener Bedarf');
    const note = addNote(contact.id, 'Eine Notiz');

    expect(() => deleteNeed(need.id)).not.toThrow();
    expect(() => deleteNote(note.id)).not.toThrow();
    expect(() => deleteContact(contact.id)).not.toThrow();
    expect(() => deleteContact(contact.id)).toThrow(NotFoundError);
  });

  it('haengt Tags idempotent ab, verlangt aber einen existierenden Kontakt', () => {
    const contact = createContact({ name: 'Tag Testperson', status: 'active' });
    const tag = addTagToContact(contact.id, 'healthtech');

    removeTagFromContact(contact.id, tag.id);
    expect(listTagsForContact(contact.id)).toHaveLength(0);
    // Zweites Abhaengen stellt denselben Zielzustand her - kein Fehler.
    expect(() => removeTagFromContact(contact.id, tag.id)).not.toThrow();
    expect(() => removeTagFromContact(999999, tag.id)).toThrow(NotFoundError);
  });
});

describe('findMatches: Tags matchen nicht breiter als Freitext', () => {
  it('laesst einen einbuchstabigen Tag nicht auf laengere Tags treffen', () => {
    const solo = createContact({ name: 'Solo Tagperson', status: 'active' });
    addTagToContact(solo.id, 'b');
    const first = createContact({ name: 'Biotech Eins', status: 'active' });
    addTagToContact(first.id, 'biotech');
    const second = createContact({ name: 'Biotech Zwei', status: 'active' });
    addTagToContact(second.id, 'biotech');

    expect(findMatches({ contactId: solo.id })).toHaveLength(0);
    // Gegenprobe: derselbe Begriff als Freitext liefert ebenfalls nichts.
    expect(findMatches({ query: 'b' })).toHaveLength(0);
  });

  it('laesst ein Stoppwort als Tag nicht auf verwandte Tags treffen', () => {
    const source = createContact({ name: 'Stoppwort Tagperson', status: 'active' });
    addTagToContact(source.id, 'suche');
    const other = createContact({ name: 'Suchen Person', status: 'active' });
    addTagToContact(other.id, 'suchen');

    expect(findMatches({ contactId: source.id })).toHaveLength(0);
  });

  it('findet kurze Tags weiterhin, wenn sie exakt uebereinstimmen', () => {
    const source = createContact({ name: 'AI Person Eins', status: 'active' });
    addTagToContact(source.id, 'ai');
    const other = createContact({ name: 'AI Person Zwei', status: 'active' });
    addTagToContact(other.id, 'ai');

    const matches = findMatches({ contactId: source.id });
    expect(matches.map((candidate) => candidate.contact.name)).toEqual(['AI Person Zwei']);
    expect(matches[0]?.matched_on).toEqual([{ kind: 'tag', text: 'ai', term: 'ai' }]);
  });

  it('findet den Investor zum Founder ueber Need und Offer', () => {
    const founder = createContact({ name: 'Lena Founder', status: 'active', role: 'founder' });
    addNeed(founder.id, 'Sucht Seed-Investor fuer HealthTech, Runde 800k');

    const investor = createContact({ name: 'Paul Investor', status: 'active', role: 'investor' });
    addOffer(investor.id, 'Investiere als Business Angel in HealthTech, Tickets 100-500k');

    const noise = createContact({ name: 'Nora Nebensache', status: 'active' });
    addOffer(noise.id, 'Biete Nachhilfe in Gitarre');

    const matches = findMatches({ contactId: founder.id });
    expect(matches.map((candidate) => candidate.contact.name)).toEqual(['Paul Investor']);
    expect(matches[0]?.matched_on.map((evidence) => evidence.term)).toContain('healthtech');
    // Kein Score - das Tool liefert Belege, keine Bewertung.
    expect(JSON.stringify(matches)).not.toMatch(/score/i);
  });

  it('liefert erledigte Offers nicht mehr als Beleg', () => {
    const founder = createContact({ name: 'Mira Founder', status: 'active' });
    addNeed(founder.id, 'Sucht Patentanwaeltin fuer Medizinprodukte');

    const lawyer = createContact({ name: 'Rita Anwaeltin', status: 'active' });
    const offer = addOffer(lawyer.id, 'Vermittle Patentanwaeltin fuer Medizinprodukte');

    expect(findMatches({ contactId: founder.id })).toHaveLength(1);

    // Erledigt heisst nicht geloescht: der Text bleibt im Index, taucht aber
    // nicht mehr als offener Beleg auf.
    resolveOffer(offer.id);
    expect(findMatches({ contactId: founder.id })).toHaveLength(0);
  });

  it('schlaegt nur aktive Kontakte vor', () => {
    const founder = createContact({ name: 'Jonas Founder', status: 'active' });
    addNeed(founder.id, 'Sucht Vertriebsleiterin fuer Industriekunden');

    const importedCandidate = createContact({ name: 'Ida Importiert', status: 'imported' });
    addOffer(importedCandidate.id, 'Vermittle Vertriebsleiterin fuer Industriekunden');
    const archivedCandidate = createContact({ name: 'Arno Archiviert', status: 'archived' });
    addOffer(archivedCandidate.id, 'Vermittle Vertriebsleiterin fuer Industriekunden');

    expect(findMatches({ contactId: founder.id })).toHaveLength(0);
  });
});
