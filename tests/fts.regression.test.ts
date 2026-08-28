import { beforeEach, describe, expect, it } from 'vitest';

import { getDb, withTransaction } from '@/lib/db';
import {
  addNeed,
  addNote,
  addOffer,
  createContact,
  deleteContact,
  getAllContactsForDedup,
  listContacts,
  searchContactsFts,
} from '@/lib/queries';

/**
 * Eigenschaften des Volltextindex contacts_fts.
 *
 * Zum rohen SQL in dieser Datei: die Architekturregel haelt SQL aus den
 * Anwendungs- und Logikschichten heraus (app/, lib/ ausser queries.ts, mcp/,
 * scripts/). Hier geht es um zwei Dinge, die sich ueber die oeffentliche API
 * bewusst NICHT ausdruecken lassen: eine echte Phrasenabfrage (die
 * toFtsPrefixQuery absichtlich nie erzeugt) und der direkte Blick in den
 * Index. Beide Zugriffe sind ausschliesslich lesend.
 */

/** Leert die Kontakte (Cascade raeumt alles Abhaengige mit). */
function resetContacts(): void {
  withTransaction(() => {
    for (const row of getAllContactsForDedup()) {
      deleteContact(row.id);
    }
  });
}

function ftsRowIds(matchExpression: string): number[] {
  const rows = getDb()
    .prepare('SELECT rowid AS id FROM contacts_fts WHERE contacts_fts MATCH ?')
    .all(matchExpression);
  return rows.map((row) => Number((row as { id: number }).id));
}

function ftsRowCount(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS total FROM contacts_fts').get();
  return Number((row as { total: number }).total);
}

beforeEach(() => {
  resetContacts();
});

describe('Notizen bleiben aus dem Index heraus', () => {
  it('indexiert Name, Firma, Titel, how_we_met, Needs und Offers - aber keine Notiz', () => {
    const contact = createContact({
      name: 'Alina Vogt',
      status: 'active',
      company: 'Nordwind Robotics',
      title: 'Head of Hardware',
      how_we_met: 'Konferenz in Leipzig',
    });
    addNeed(contact.id, 'Sucht Fertigungspartner');
    addOffer(contact.id, 'Bietet Prototypenbau');
    addNote(contact.id, 'Vertraulich: GEHEIMESNOTIZWORT, bitte nicht erwaehnen');

    for (const term of [
      'Alina',
      'Nordwind',
      'Hardware',
      'Leipzig',
      'Fertigungspartner',
      'Prototypenbau',
    ]) {
      expect(searchContactsFts(term), `Begriff ${term}`).toHaveLength(1);
    }

    expect(searchContactsFts('GEHEIMESNOTIZWORT')).toHaveLength(0);
    expect(listContacts({ query: 'GEHEIMESNOTIZWORT' })).toHaveLength(0);
  });
});

describe('Trigger halten den Index deckungsgleich mit contacts', () => {
  it('legt genau eine Zeile pro Kontakt an und raeumt beim Loeschen auf', () => {
    const ids: number[] = [];
    withTransaction(() => {
      for (let i = 0; i < 50; i += 1) {
        const contact = createContact({ name: `Index Person ${i}`, status: 'active' });
        addNeed(contact.id, `Bedarf Nummer ${i}`);
        ids.push(contact.id);
      }
    });

    expect(ftsRowCount()).toBe(50);

    withTransaction(() => {
      for (const id of ids.slice(0, 20)) {
        deleteContact(id);
      }
    });

    expect(ftsRowCount()).toBe(30);
    expect(getAllContactsForDedup()).toHaveLength(30);
  });

  it('faltet diakritische Zeichen (remove_diacritics 2)', () => {
    createContact({ name: 'Tomaž Kosmač', status: 'active', city: 'Škofja Loka' });
    expect(searchContactsFts('Tomaz')).toHaveLength(1);
    expect(searchContactsFts('Kosmac')).toHaveLength(1);
    expect(searchContactsFts('TOMAZ')).toHaveLength(1);
  });
});

describe('Phrasengenauigkeit ueber needs_text und offers_text', () => {
  /**
   * Dokumentierte Einschraenkung, kein Bug im Index.
   *
   * needs_text entsteht im Trigger ueber group_concat(n.text, ' '). Mehrere
   * getrennte Needs verschmelzen dort zu einem Tokenstrom, eine FTS5-Phrase
   * kann deshalb ueber die Grenze zwischen zwei Needs hinweg matchen. Echte
   * Feldgenauigkeit bekaeme man nur mit einer eigenen FTS-Tabelle mit einer
   * Zeile pro Need - das widerspricht der bindenden Vorgabe
   * "rowid == contacts.id" und ist hier bewusst nicht gemacht.
   *
   * Der Schutz liegt eine Ebene hoeher: toFtsPrefixQuery baut niemals eine
   * mehrwortige Phrase (siehe tests/normalize.test.ts). Wer diese Regel
   * spaeter aufweicht - "exakte Phrase" im UI, MCP-Server, Broker-Matching -
   * bekommt dieses Verhalten und muss es einkalkulieren.
   */
  it('matcht eine Phrase ueber die Grenze zwischen zwei Needs hinweg', () => {
    const contact = createContact({ name: 'Phrasen Person', status: 'active' });
    addNeed(contact.id, 'sucht Buchhaltung');
    addNeed(contact.id, 'Software fuer KMU');

    // Diese Wortfolge steht in keinem einzelnen Need - der Index sieht sie
    // trotzdem, weil beide Needs zu einem Text verkettet werden.
    expect(ftsRowIds('"Buchhaltung Software"')).toEqual([contact.id]);

    // Genau deshalb erzeugt die oeffentliche Suche keine Phrasen: ueber sie
    // ist der Kontakt nur ueber beide Begriffe einzeln erreichbar, was
    // korrekt ist.
    expect(searchContactsFts('Buchhaltung Software')).toEqual([contact.id]);
    expect(searchContactsFts('Buchhaltung')).toEqual([contact.id]);
  });

  it('betrifft offers_text genauso', () => {
    const contact = createContact({ name: 'Phrasen Zweitperson', status: 'active' });
    addOffer(contact.id, 'bietet Lagerflaeche');
    addOffer(contact.id, 'Logistik im Sueden');

    expect(ftsRowIds('"Lagerflaeche Logistik"')).toEqual([contact.id]);
  });
});
