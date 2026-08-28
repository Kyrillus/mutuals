import { describe, expect, it } from 'vitest';

import { applyMapping, mapRow, suggestMapping } from '@/lib/import/mapping';
import type { ColumnMapping, RawRow } from '@/lib/import/types';

/**
 * Spaltenzuordnung und Zeilendeutung.
 *
 * Zwei Fehlerklassen sind hier teuer und stehen deshalb im Mittelpunkt:
 *   - Eine Spalte wandert stillschweigend nirgendwohin. Dann fehlen hinterher
 *     Daten, ohne dass es jemand gemerkt haette - deshalb muss jede nicht
 *     zugeordnete Spalte in unmapped auftauchen und confident kippen.
 *   - Ein Wert wird geraten (Datum, Geburtstag). Dann steht etwas Falsches in
 *     der Datenbank, was schlimmer ist als ein leeres Feld.
 */

const LINKEDIN_HEADERS = [
  'First Name',
  'Last Name',
  'URL',
  'Email Address',
  'Company',
  'Position',
  'Connected On',
];

/** Baut eine Zeile aus Headern und Werten - Kurzschreibweise fuer die Tests. */
function row(values: Record<string, string>): RawRow {
  return values;
}

describe('suggestMapping: LinkedIn', () => {
  it('ordnet die sieben Spalten des Exports genau so zu, wie es vorgegeben ist', () => {
    const suggestion = suggestMapping(LINKEDIN_HEADERS);

    expect(suggestion.mapping).toEqual({
      'First Name': { kind: 'name_part', part: 'first' },
      'Last Name': { kind: 'name_part', part: 'last' },
      URL: { kind: 'field', field: 'linkedin_url' },
      'Email Address': { kind: 'field', field: 'email' },
      Company: { kind: 'field', field: 'company' },
      Position: { kind: 'field', field: 'title' },
      'Connected On': { kind: 'field', field: 'created_at' },
    });
    expect(suggestion.detectedSource).toBe('linkedin');
    expect(suggestion.unmapped).toEqual([]);
    expect(suggestion.confident).toBe(true);
  });

  it('erkennt den Export auch, wenn eine Spalte fehlt', () => {
    const suggestion = suggestMapping(LINKEDIN_HEADERS.filter((header) => header !== 'Company'));
    expect(suggestion.detectedSource).toBe('linkedin');
    expect(suggestion.confident).toBe(true);
  });

  it('haelt ein nacktes "URL" ausserhalb von LinkedIn fuer keine Profil-URL', () => {
    // 'URL' ist in einer beliebigen Datei eher die Firmenwebsite - und ein Feld
    // dafuer gibt es im Kontakt nicht. Lieber nachfragen als falsch einsortieren.
    const suggestion = suggestMapping(['Name', 'URL']);

    expect(suggestion.mapping['URL']).toEqual({ kind: 'ignore' });
    expect(suggestion.unmapped).toEqual(['URL']);
    expect(suggestion.confident).toBe(false);
  });
});

describe('suggestMapping: andere Exporte', () => {
  it('erkennt deutsche Spaltennamen unabhaengig von Schreibweise und Sonderzeichen', () => {
    const suggestion = suggestMapping([
      'VORNAME',
      'nachname',
      'E-Mail',
      'Firma',
      'Position',
      'Stadt',
      'Land',
      'Telefon',
      'Geburtstag',
    ]);

    expect(suggestion.mapping).toEqual({
      VORNAME: { kind: 'name_part', part: 'first' },
      nachname: { kind: 'name_part', part: 'last' },
      'E-Mail': { kind: 'field', field: 'email' },
      Firma: { kind: 'field', field: 'company' },
      Position: { kind: 'field', field: 'title' },
      Stadt: { kind: 'field', field: 'city' },
      Land: { kind: 'field', field: 'country' },
      Telefon: { kind: 'field', field: 'phone' },
      Geburtstag: { kind: 'field', field: 'birthday' },
    });
    expect(suggestion.detectedSource).toBe('unknown');
    expect(suggestion.confident).toBe(true);
  });

  it('erkennt die kurze deutsche Kopfzeile', () => {
    // Vorname/Nachname/E-Mail/Firma/Ort ist das, was aus Outlook, einem
    // Vereinsverzeichnis oder einer von Hand gepflegten Liste kommt.
    const suggestion = suggestMapping(['Vorname', 'Nachname', 'E-Mail', 'Firma', 'Ort']);

    expect(suggestion.mapping).toEqual({
      Vorname: { kind: 'name_part', part: 'first' },
      Nachname: { kind: 'name_part', part: 'last' },
      'E-Mail': { kind: 'field', field: 'email' },
      Firma: { kind: 'field', field: 'company' },
      Ort: { kind: 'field', field: 'city' },
    });
    expect(suggestion.unmapped).toEqual([]);
    expect(suggestion.confident).toBe(true);
  });

  it('erkennt "Verbunden am" als Anlagedatum', () => {
    const suggestion = suggestMapping(['Name', 'Verbunden am']);
    expect(suggestion.mapping['Verbunden am']).toEqual({ kind: 'field', field: 'created_at' });
  });

  it('vergibt jedes Ziel nur einmal und legt den zweiten Kandidaten offen', () => {
    // Sonst entschiede die Spaltenreihenfolge stillschweigend, welche der
    // beiden E-Mail-Spalten gewinnt.
    const suggestion = suggestMapping(['Name', 'E-Mail', 'Mail']);

    expect(suggestion.mapping['E-Mail']).toEqual({ kind: 'field', field: 'email' });
    expect(suggestion.mapping['Mail']).toEqual({ kind: 'ignore' });
    expect(suggestion.unmapped).toEqual(['Mail']);
    expect(suggestion.confident).toBe(false);
  });

  it('ist ohne Namensspalte nie sicher', () => {
    const suggestion = suggestMapping(['E-Mail', 'Firma']);
    expect(suggestion.confident).toBe(false);
  });

  it('nennt jede unbekannte Spalte, statt sie zu verschlucken', () => {
    const suggestion = suggestMapping(['Name', 'Bemerkung', 'Spalte 3']);

    expect(suggestion.unmapped).toEqual(['Bemerkung', 'Spalte 3']);
    expect(suggestion.mapping['Bemerkung']).toEqual({ kind: 'ignore' });
    expect(suggestion.confident).toBe(false);
  });

  it('raet bei einer aehnlich klingenden Spalte kein Feld herbei', () => {
    // 'Website' und 'Xing-Profil' sind keine LinkedIn-Profile, und ein Feld
    // fuer sie gibt es im Kontakt nicht. Etwas hineinzuraten hiesse, falsche
    // Werte in linkedin_url zu schreiben - schlimmer als eine Rueckfrage.
    const suggestion = suggestMapping(['Name', 'Website', 'Xing-Profil', 'Notizen']);

    expect(suggestion.unmapped).toEqual(['Website', 'Xing-Profil', 'Notizen']);
    expect(Object.values(suggestion.mapping).filter((target) => target.kind !== 'ignore')).toEqual([
      { kind: 'field', field: 'name' },
    ]);
  });

  it('fuehrt jeden Header der Datei in der Zuordnung auf', () => {
    // Auch den ignorierten: eine unvollstaendige Zuordnung liesse offen, ob
    // eine Spalte vergessen oder bewusst ausgelassen wurde.
    const headers = ['Name', 'Bemerkung', 'E-Mail'];
    expect(Object.keys(suggestMapping(headers).mapping)).toEqual(headers);
  });
});

describe('applyMapping: Name', () => {
  const mapping = suggestMapping(LINKEDIN_HEADERS).mapping;

  it('setzt Vor- und Nachname in dieser Reihenfolge zusammen und trimmt dabei', () => {
    const contact = applyMapping(
      row({ 'First Name': '  Lena  ', 'Last Name': '  Schmidt  ' }),
      mapping,
    );
    expect(contact.name).toBe('Lena Schmidt');
  });

  it('nimmt die vorhandene Haelfte, wenn eine fehlt', () => {
    expect(applyMapping(row({ 'First Name': 'Kwame', 'Last Name': '' }), mapping).name).toBe(
      'Kwame',
    );
    expect(applyMapping(row({ 'First Name': '', 'Last Name': 'Nakamura' }), mapping).name).toBe(
      'Nakamura',
    );
  });

  it('laesst name weg, wenn beide Haelften leer sind', () => {
    const contact = applyMapping(row({ 'First Name': ' ', 'Last Name': '' }), mapping);
    expect(contact.name).toBeUndefined();
  });

  it('bevorzugt eine echte name-Spalte vor den Namensteilen', () => {
    const withFullName = suggestMapping(['Name', 'First Name', 'Last Name']).mapping;
    const contact = applyMapping(
      row({ Name: 'Dr. Lena Schmidt', 'First Name': 'Lena', 'Last Name': 'Schmidt' }),
      withFullName,
    );
    expect(contact.name).toBe('Dr. Lena Schmidt');
  });
});

describe('applyMapping: Werte', () => {
  const mapping = suggestMapping(LINKEDIN_HEADERS).mapping;

  it('macht aus einer leeren Zelle null und nicht den leeren String', () => {
    const contact = applyMapping(
      row({ 'First Name': 'Paul', 'Last Name': 'Brandner', 'Email Address': '   ' }),
      mapping,
    );
    expect(contact.email).toBeNull();
  });

  it('laesst ein Feld unberuehrt, zu dem die Datei gar keine Spalte hat', () => {
    // Unterschied "die Datei sagt: kein Wert" (null) und "die Datei sagt dazu
    // nichts" (undefined) - nur letzteres darf enrichContact nie erreichen.
    const contact = applyMapping(row({ 'First Name': 'Paul', 'Last Name': 'Brandner' }), mapping);
    expect(contact.city).toBeUndefined();
    expect(contact.phone).toBeUndefined();
  });

  it('macht aus einer Spalte, die in der Zeile fehlt, ebenfalls null', () => {
    // Die Datei hat eine Company-Spalte, diese Zeile hat dort nichts stehen.
    const contact = applyMapping(row({ 'First Name': 'Paul', 'Last Name': 'Brandner' }), mapping);
    expect(contact.company).toBeNull();
    expect('company' in contact).toBe(true);
  });

  it('traegt aus einer ignorierten Spalte nichts in den Kontakt', () => {
    const withNote = suggestMapping(['Name', 'Bemerkung']).mapping;
    const contact = applyMapping(
      row({ Name: 'Anna Schmidt', Bemerkung: 'auf der Messe getroffen' }),
      withNote,
    );

    // Nur der Name - insbesondere landet die Bemerkung nicht in how_we_met.
    expect(contact).toEqual({ name: 'Anna Schmidt' });
  });

  it('behaelt den Zeilenumbruch in einem mehrzeiligen Firmennamen', () => {
    const contact = applyMapping(
      row({ 'First Name': 'Zoe', 'Last Name': 'Williams', Company: 'Anthropic\nPBC' }),
      mapping,
    );
    expect(contact.company).toBe('Anthropic\nPBC');
  });

  it('entfernt Steuerzeichen aus den Werten', () => {
    const nul = String.fromCharCode(0);
    const contact = applyMapping(
      row({ 'First Name': `Pa${nul}ul`, 'Last Name': 'Brandner', Company: `Acme${nul}` }),
      mapping,
    );
    expect(contact.name).toBe('Paul Brandner');
    expect(contact.company).toBe('Acme');
  });
});

describe('applyMapping: Daten', () => {
  const mapping = suggestMapping(LINKEDIN_HEADERS).mapping;

  it('uebersetzt "Connected On" nach ISO', () => {
    const contact = applyMapping(
      row({ 'First Name': 'Paul', 'Last Name': 'Brandner', 'Connected On': '14 Mar 2023' }),
      mapping,
    );
    expect(contact.created_at).toBe('2023-03-14');
  });

  it('laesst created_at weg, wenn das Datum unlesbar ist', () => {
    // Die Query-Schicht setzt dann den aktuellen Zeitstempel. Ein geratenes
    // Datum waere schlechter als keines.
    const contact = applyMapping(
      row({ 'First Name': 'Paul', 'Last Name': 'Brandner', 'Connected On': '03/14/2023' }),
      mapping,
    );
    expect(contact.created_at).toBeUndefined();
  });

  it('nimmt den Geburtstag in beiden Formen des Datenmodells an', () => {
    const withBirthday: ColumnMapping = {
      Name: { kind: 'field', field: 'name' },
      Geburtstag: { kind: 'field', field: 'birthday' },
    };

    expect(applyMapping(row({ Name: 'A', Geburtstag: '14.03.1990' }), withBirthday).birthday).toBe(
      '1990-03-14',
    );
    expect(applyMapping(row({ Name: 'A', Geburtstag: '--03-14' }), withBirthday).birthday).toBe(
      '--03-14',
    );
    // Unlesbares wird null - die Zeile soll deswegen nicht scheitern.
    expect(
      applyMapping(row({ Name: 'A', Geburtstag: 'im Frühling' }), withBirthday).birthday,
    ).toBeNull();
  });
});

describe('Werte, die nicht uebernommen werden, sind gemeldet', () => {
  it('nennt ein unlesbares Datum samt Originalwert', () => {
    // Ohne diese Meldung ist die Zeile von einer mit leerer Datumsspalte nicht
    // zu unterscheiden - der Kontakt traegt dann den Importzeitpunkt.
    const mapping: ColumnMapping = {
      Name: { kind: 'field', field: 'name' },
      'Connected On': { kind: 'field', field: 'created_at' },
    };

    const unlesbar = mapRow(row({ Name: 'Us Ulrich', 'Connected On': '03/14/2023' }), mapping);
    expect(unlesbar.contact.created_at).toBeUndefined();
    expect(unlesbar.dropped).toEqual([
      { field: 'created_at', value: '03/14/2023', reason: 'unlesbares Datum' },
    ]);

    // Leer ist keine Meldung wert: die Datei sagt dazu schlicht nichts.
    expect(mapRow(row({ Name: 'Leer Lena', 'Connected On': '' }), mapping).dropped).toEqual([]);
    // Lesbares Datum ebenso wenig.
    const gut = mapRow(row({ Name: 'Text Theo', 'Connected On': '14 Mar 2023' }), mapping);
    expect(gut.contact.created_at).toBe('2023-03-14');
    expect(gut.dropped).toEqual([]);
  });

  it('verwirft Platzhalter in der E-Mail-Spalte, statt sie als Adresse zu speichern', () => {
    // dedupe.ts lehnt genau diese Werte schon als Dublettenschluessel ab -
    // dieselbe Pruefung muss auch vor dem Schreiben greifen.
    const mapping: ColumnMapping = {
      Name: { kind: 'field', field: 'name' },
      'E-Mail': { kind: 'field', field: 'email' },
    };

    for (const platzhalter of ['n/a', '-', 'unbekannt', 'keine']) {
      const mapped = mapRow(row({ Name: 'Test Platzhalter', 'E-Mail': platzhalter }), mapping);
      expect(mapped.contact.email, platzhalter).toBeNull();
      expect(mapped.dropped, platzhalter).toEqual([
        { field: 'email', value: platzhalter, reason: 'keine E-Mail-Adresse' },
      ]);
    }

    const echt = mapRow(row({ Name: 'Anna Meier', 'E-Mail': 'anna@example.com' }), mapping);
    expect(echt.contact.email).toBe('anna@example.com');
    expect(echt.dropped).toEqual([]);
  });

  it('gibt ueber applyMapping weiterhin nur den Kontakt zurueck', () => {
    // Der im Kontrakt festgelegte Name bleibt, was er war.
    const mapping: ColumnMapping = { Name: { kind: 'field', field: 'name' } };
    expect(applyMapping(row({ Name: 'Anna Meier' }), mapping)).toEqual({ name: 'Anna Meier' });
  });
});

describe('Eine Spalte namens __proto__', () => {
  it('bekommt einen eigenen Eintrag in der Zuordnung', () => {
    const suggestion = suggestMapping(['__proto__', 'E-Mail']);

    expect(Object.hasOwn(suggestion.mapping, '__proto__')).toBe(true);
    expect(suggestion.unmapped).toContain('__proto__');
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it('wird als Zellwert gelesen und nicht vom Prototyp geholt', () => {
    // Ein von aussen gereichtes RawRow kann ein gewoehnliches Objektliteral
    // sein. Dort liefert row['toString'] eine geerbte Funktion - die darf
    // nicht als Firmenname im Kontakt landen.
    const mapping: ColumnMapping = {
      Name: { kind: 'field', field: 'name' },
    };
    mapping['toString'] = { kind: 'field', field: 'company' };
    const mapped = mapRow({ Name: 'Anna Meier' }, mapping);

    expect(mapped.contact.name).toBe('Anna Meier');
    expect(mapped.contact.company).toBeNull();
  });
});
