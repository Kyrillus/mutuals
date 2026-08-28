import { describe, expect, it } from 'vitest';

import {
  looksLikeEmail,
  normalizeEmail,
  normalizeLinkedinUrl,
  normalizeName,
  parseConnectedOn,
} from '@/lib/import/normalize';
import { normalizeLinkedinUrl as dbLinkedinUrl, normalizePersonName } from '@/lib/queries';

/**
 * Reine Funktionen, keine Datenbank. Getestet wird die Faltung, auf der die
 * Dedup-Kaskade des Imports steht - hier entscheidet sich, ob zwei
 * Schreibweisen derselben Person auf denselben Schluessel fallen.
 */

const NUL = String.fromCharCode(0);

describe('normalizeName', () => {
  it('faltet Gross-/Kleinschreibung, Diakritika und Whitespace', () => {
    expect(normalizeName('Jürgen  Müller ')).toBe('jurgen muller');
    expect(normalizeName('JURGEN MULLER')).toBe('jurgen muller');
    expect(normalizeName('Jürgen  Müller ')).toBe(normalizeName('JURGEN MULLER'));
  });

  it('faltet auch slowenische und spanische Diakritika', () => {
    expect(normalizeName('Tomaž Kosmač')).toBe('tomaz kosmac');
    expect(normalizeName('Sofía Grünwald')).toBe(normalizeName('SOFIA GRUNWALD'));
  });

  it('liefert leer, wenn kein Namensbestandteil uebrig bleibt', () => {
    expect(normalizeName('')).toBe('');
    expect(normalizeName('   ')).toBe('');
    expect(normalizeName(NUL)).toBe('');
  });

  it('unterscheidet weiterhin verschiedene Personen', () => {
    expect(normalizeName('Anna Schmidt')).not.toBe(normalizeName('Anne Schmidt'));
    expect(normalizeName('Paul Brandner')).not.toBe(normalizeName('Paula Brandner'));
  });

  it('benutzt dieselbe Faltung wie die Datenbankschicht', () => {
    // Das ist der eigentliche Punkt dieser Funktion: sie delegiert an
    // normalizePersonName. Zwei getrennte Implementierungen wuerden
    // frueher oder spaeter auseinanderlaufen, und dann sieht der Import
    // einen Kontakt als neu an, den die Datenbankschicht sehr wohl findet.
    for (const raw of ['Jürgen Müller', 'Tomaž Kosmač', 'Ana-Maria O’Brien', '   ']) {
      expect(normalizeName(raw)).toBe(normalizePersonName(raw));
    }
  });
});

describe('normalizeEmail', () => {
  it('trimmt und schreibt klein', () => {
    expect(normalizeEmail('  Anna@Example.COM ')).toBe('anna@example.com');
    expect(normalizeEmail('ANNA@EXAMPLE.COM')).toBe(normalizeEmail('anna@example.com'));
  });

  it('entfernt Whitespace auch innerhalb der Adresse', () => {
    expect(normalizeEmail('anna @example.com')).toBe('anna@example.com');
    expect(normalizeEmail('anna@ example.com')).toBe('anna@example.com');
  });

  it('entfernt Steuerzeichen', () => {
    expect(normalizeEmail(`anna${NUL}@example.com`)).toBe('anna@example.com');
  });

  it('faltet KEINE Diakritika - das waeren andere Postfaecher', () => {
    expect(normalizeEmail('jürgen@example.de')).toBe('jürgen@example.de');
    expect(normalizeEmail('jürgen@example.de')).not.toBe(normalizeEmail('jurgen@example.de'));
  });

  it('liefert leer fuer leere Eingaben', () => {
    expect(normalizeEmail('')).toBe('');
    expect(normalizeEmail('   ')).toBe('');
  });
});

describe('normalizeLinkedinUrl', () => {
  it('bildet die drei Varianten desselben Profils auf einen Schluessel ab', () => {
    const expected = 'https://www.linkedin.com/in/paulbrandner';
    expect(normalizeLinkedinUrl('https://www.linkedin.com/in/paulbrandner')).toBe(expected);
    expect(normalizeLinkedinUrl('http://linkedin.com/in/paulbrandner/')).toBe(expected);
    expect(normalizeLinkedinUrl('https://www.linkedin.com/in/paulbrandner?utm_source=share')).toBe(
      expected,
    );
  });

  it('vereinheitlicht Schema, Host, Grossschreibung, Fragment und Leerraum', () => {
    const expected = 'https://www.linkedin.com/in/anna-schmidt';
    expect(normalizeLinkedinUrl('http://WWW.LinkedIn.com/in/Anna-Schmidt')).toBe(expected);
    expect(normalizeLinkedinUrl('www.linkedin.com/in/anna-schmidt')).toBe(expected);
    expect(normalizeLinkedinUrl('linkedin.com/in/anna-schmidt')).toBe(expected);
    expect(normalizeLinkedinUrl('https://www.linkedin.com/in/anna-schmidt#kontakt')).toBe(expected);
    expect(normalizeLinkedinUrl('  https://www.linkedin.com/in/anna-schmidt/  ')).toBe(expected);
    expect(
      normalizeLinkedinUrl('https://www.linkedin.com/in/anna-schmidt/?originalSubdomain=de'),
    ).toBe(expected);
  });

  it('faltet die Laendersubdomains von LinkedIn mit', () => {
    // de.linkedin.com/in/x und www.linkedin.com/in/x sind dasselbe Profil.
    const expected = 'https://www.linkedin.com/in/anna-schmidt';
    expect(normalizeLinkedinUrl('https://de.linkedin.com/in/anna-schmidt')).toBe(expected);
    expect(normalizeLinkedinUrl('https://uk.linkedin.com/in/anna-schmidt')).toBe(expected);
  });

  it('unterscheidet verschiedene Profile', () => {
    expect(normalizeLinkedinUrl('https://www.linkedin.com/in/anna-schmidt')).not.toBe(
      normalizeLinkedinUrl('https://www.linkedin.com/in/anne-schmidt'),
    );
  });

  it('liefert leer fuer leere Eingaben und laesst Unlesbares stehen', () => {
    expect(normalizeLinkedinUrl('')).toBe('');
    expect(normalizeLinkedinUrl('   ')).toBe('');
    expect(normalizeLinkedinUrl('kein url text hier')).not.toBe('');
  });

  it('ist idempotent - der Schluessel eines Schluessels ist derselbe', () => {
    for (const raw of [
      'https://www.linkedin.com/in/paulbrandner',
      'http://linkedin.com/in/paulbrandner/',
      'kein url text hier',
      '',
    ]) {
      const once = normalizeLinkedinUrl(raw);
      expect(normalizeLinkedinUrl(once)).toBe(once);
    }
  });

  it('stimmt fuer die kanonische Exportform mit der Datenbankschicht ueberein', () => {
    // Der Import darf keinen anderen Schluessel bilden als den, unter dem die
    // URL gespeichert und ueber findContactByLinkedinUrl gesucht wird - sonst
    // findet der zweite Lauf die Kontakte des ersten nicht wieder. Die
    // zusaetzliche Host-Faltung dieses Moduls ist ein reiner Aufsatz: fuer die
    // Form, die LinkedIn exportiert, kommt beidesmal dasselbe heraus.
    for (const raw of [
      'https://www.linkedin.com/in/paulbrandner',
      'https://www.linkedin.com/in/anna-schmidt/',
      'https://www.linkedin.com/in/anna-schmidt?utm_source=share',
    ]) {
      expect(normalizeLinkedinUrl(raw)).toBe(dbLinkedinUrl(raw));
    }
  });
});

describe('parseConnectedOn', () => {
  it('liest das LinkedIn-Format', () => {
    expect(parseConnectedOn('14 Mar 2023')).toBe('2023-03-14');
    expect(parseConnectedOn('1 Jan 2020')).toBe('2020-01-01');
    expect(parseConnectedOn('09 Aug 2021')).toBe('2021-08-09');
  });

  it('kennt alle englischen Monate, abgekuerzt und ausgeschrieben', () => {
    const months: [string, string, string][] = [
      ['Jan', 'January', '01'],
      ['Feb', 'February', '02'],
      ['Mar', 'March', '03'],
      ['Apr', 'April', '04'],
      ['May', 'May', '05'],
      ['Jun', 'June', '06'],
      ['Jul', 'July', '07'],
      ['Aug', 'August', '08'],
      ['Sep', 'September', '09'],
      ['Oct', 'October', '10'],
      ['Nov', 'November', '11'],
      ['Dec', 'December', '12'],
    ];
    for (const [short, long, number] of months) {
      expect(parseConnectedOn(`14 ${short} 2023`)).toBe(`2023-${number}-14`);
      expect(parseConnectedOn(`14 ${long} 2023`)).toBe(`2023-${number}-14`);
      expect(parseConnectedOn(`${short} 14, 2023`)).toBe(`2023-${number}-14`);
    }
  });

  it('kennt die deutschen Monatsnamen des deutschsprachigen Exports', () => {
    expect(parseConnectedOn('14. März 2023')).toBe('2023-03-14');
    expect(parseConnectedOn('5 Mai 2021')).toBe('2021-05-05');
    expect(parseConnectedOn('14 Okt 2022')).toBe('2022-10-14');
    expect(parseConnectedOn('14 Dez 2022')).toBe('2022-12-14');
    expect(parseConnectedOn('1 Januar 2020')).toBe('2020-01-01');
  });

  it('liest Monat-Tag-Jahr, ISO und das deutsche Punktformat', () => {
    expect(parseConnectedOn('Mar 14, 2023')).toBe('2023-03-14');
    expect(parseConnectedOn('March 14 2023')).toBe('2023-03-14');
    expect(parseConnectedOn('Sept. 3, 2019')).toBe('2019-09-03');
    expect(parseConnectedOn('2023-03-14')).toBe('2023-03-14');
    expect(parseConnectedOn('2023/3/4')).toBe('2023-03-04');
    expect(parseConnectedOn('2023-03-14T09:12:00Z')).toBe('2023-03-14');
    expect(parseConnectedOn('14.03.2023')).toBe('2023-03-14');
    expect(parseConnectedOn('1.1.2020')).toBe('2020-01-01');
    expect(parseConnectedOn('31.12.1999')).toBe('1999-12-31');
  });

  it('ignoriert Leerraum und Steuerzeichen um den Wert herum', () => {
    expect(parseConnectedOn('  14 Mar 2023  ')).toBe('2023-03-14');
    expect(parseConnectedOn(`14 Mar 2023${NUL}`)).toBe('2023-03-14');
  });

  it('liefert null statt zu raten oder zu werfen', () => {
    for (const raw of [
      '',
      '   ',
      'gestern',
      'Connected On',
      '14 Foo 2023',
      '14 Mar 23', // zweistelliges Jahr: das Jahrhundert waere geraten
      '44999', // Excel-Seriennummer: hier ist jede Zahl ein Datum
      '2023',
      'Mar 2023',
      '14 Mar 2023 extra wort',
      NUL,
    ]) {
      expect(parseConnectedOn(raw), raw).toBeNull();
    }
  });

  it('raet bei mehrdeutigen Schraegstrich-Daten nicht', () => {
    // 03/14 oder 14/03 - was Tag und was Monat ist, entscheidet die Locale
    // des Exports und nicht der Wert. Lieber leer als zur Haelfte falsch.
    expect(parseConnectedOn('14/03/2023')).toBeNull();
    expect(parseConnectedOn('03/14/2023')).toBeNull();
    expect(parseConnectedOn('03/04/2023')).toBeNull();
  });

  it('weist kalendarisch unmoegliche Daten zurueck', () => {
    expect(parseConnectedOn('31 Feb 2023')).toBeNull();
    expect(parseConnectedOn('2023-02-30')).toBeNull();
    expect(parseConnectedOn('32.01.2023')).toBeNull();
    expect(parseConnectedOn('2023-13-01')).toBeNull();
    expect(parseConnectedOn('0 Mar 2023')).toBeNull();
    expect(parseConnectedOn('29 Feb 2023')).toBeNull();
    expect(parseConnectedOn('29 Feb 2024')).toBe('2024-02-29');
  });

  it('liefert ein Datum, das die Datenbankschicht akzeptiert', () => {
    const iso = parseConnectedOn('14 Mar 2023');
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(iso ?? ''))).toBe(false);
  });
});

describe('Der Import und die Query-Schicht falten die URL gleich', () => {
  /**
   * Das ist die Eigenschaft, an der alles haengt: der Dedup-Schluessel muss
   * dieselbe Faltung sein wie die, mit der der Wert gespeichert und gesucht
   * wird. Wich die eine von der anderen ab, hielte der Import zwei URLs fuer
   * denselben Menschen, waehrend findContactByLinkedinUrl die gespeicherte
   * Zeile nicht mehr faende.
   */
  const VARIANTEN = [
    'https://www.linkedin.com/in/paulbrandner',
    'http://linkedin.com/in/paulbrandner/',
    'https://www.linkedin.com/in/paulbrandner?utm_source=share',
    'https://de.linkedin.com/in/paulbrandner',
    'https://m.linkedin.com/in/paulbrandner#kontakt',
    'www.linkedin.com/in/paulbrandner',
    'linkedin.com/in/paulbrandner',
  ];

  it('bringt alle Schreibweisen auf denselben Wert', () => {
    for (const variante of VARIANTEN) {
      expect(normalizeLinkedinUrl(variante), variante).toBe(
        'https://www.linkedin.com/in/paulbrandner',
      );
    }
  });

  it('stimmt mit der Faltung der Query-Schicht ueberein', () => {
    for (const variante of VARIANTEN) {
      expect(normalizeLinkedinUrl(variante), variante).toBe(
        dbLinkedinUrl(variante).toLowerCase(),
      );
    }
  });

  it('laesst fremde Hosts in Ruhe', () => {
    // Nur linkedin.com wird vereinheitlicht - sonst wuerde aus einem anderen
    // Netzwerk stillschweigend ein LinkedIn-Profil.
    expect(normalizeLinkedinUrl('https://beispiel.de/pfad/x.linkedin.com/y')).toBe(
      'https://beispiel.de/pfad/x.linkedin.com/y',
    );
    expect(normalizeLinkedinUrl('https://notlinkedin.com/in/anna')).toBe(
      'https://notlinkedin.com/in/anna',
    );
  });
});

describe('looksLikeEmail', () => {
  it('nimmt Adressen an und weist Platzhalter zurueck', () => {
    for (const gut of ['anna@example.com', 'a@b', "o'brien@example.co.uk"]) {
      expect(looksLikeEmail(normalizeEmail(gut)), gut).toBe(true);
    }
    for (const schlecht of ['n/a', '-', 'unbekannt', '', '@example.com', 'anna@', 'a@b@c']) {
      expect(looksLikeEmail(normalizeEmail(schlecht)), schlecht).toBe(false);
    }
  });
});
