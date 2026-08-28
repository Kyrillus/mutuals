import { describe, expect, it } from 'vitest';

import {
  normalizeLinkedinUrl,
  normalizePersonName,
  normalizeTagName,
  toFtsPrefixQuery,
} from '@/lib/queries';
import { normalizeText, stripControlCharacters, stripSearchNoise } from '@/lib/text';

/**
 * Reine Funktionen ohne Datenbank. Das sind die Bausteine der Dedup-Kaskade
 * des Imports (linkedin_url -> email -> normalisierter Name) und der
 * Suchleiste - also genau die Stellen, an denen laut Auftrag die Fehler
 * passieren.
 */

const NUL = String.fromCharCode(0);

describe('normalizePersonName', () => {
  it('faltet Gross-/Kleinschreibung, Akzente und Whitespace', () => {
    expect(normalizePersonName('Tomaž  Kosmač')).toBe('tomaz kosmac');
    expect(normalizePersonName('  Jürgen   MÜLLER ')).toBe('jurgen muller');
    expect(normalizePersonName('Ana-Maria O’Brien')).toBe('ana maria o brien');
  });

  it('bildet Schreibvarianten derselben Person auf denselben Schluessel ab', () => {
    expect(normalizePersonName('Sofía Grünwald')).toBe(normalizePersonName('SOFIA GRUNWALD'));
    expect(normalizePersonName('Anna Schmidt')).toBe(normalizePersonName('anna   schmidt'));
  });

  it('unterscheidet weiterhin verschiedene Personen', () => {
    expect(normalizePersonName('Anna Schmidt')).not.toBe(normalizePersonName('Anne Schmidt'));
  });
});

describe('normalizeLinkedinUrl', () => {
  it('kanonisiert Schema, Host, Query, Fragment und Schlussslash', () => {
    const expected = 'https://www.linkedin.com/in/anna-schmidt';
    expect(normalizeLinkedinUrl('https://www.linkedin.com/in/anna-schmidt/')).toBe(expected);
    expect(normalizeLinkedinUrl('http://WWW.LinkedIn.com/in/anna-schmidt')).toBe(expected);
    expect(normalizeLinkedinUrl('www.linkedin.com/in/anna-schmidt')).toBe(expected);
    expect(
      normalizeLinkedinUrl('https://www.linkedin.com/in/anna-schmidt/?originalSubdomain=de'),
    ).toBe(expected);
    expect(normalizeLinkedinUrl('https://www.linkedin.com/in/anna-schmidt#kontakt')).toBe(expected);
    expect(normalizeLinkedinUrl('  https://www.linkedin.com/in/anna-schmidt  ')).toBe(expected);
  });

  it('laesst nicht parsebare Eingaben als getrimmten Text stehen', () => {
    expect(normalizeLinkedinUrl('   ')).toBe('');
    expect(normalizeLinkedinUrl('kein url text hier')).not.toBe('');
  });

  it('unterscheidet verschiedene Profile', () => {
    expect(normalizeLinkedinUrl('https://www.linkedin.com/in/a')).not.toBe(
      normalizeLinkedinUrl('https://www.linkedin.com/in/b'),
    );
  });
});

describe('normalizeTagName', () => {
  it('normalisiert auf ein kleingeschriebenes Slug', () => {
    expect(normalizeTagName('  HealthTech  ')).toBe('healthtech');
    expect(normalizeTagName('HEALTHTECH')).toBe('healthtech');
    expect(normalizeTagName('Health   Tech')).toBe('health-tech');
    expect(normalizeTagName('--foo--')).toBe('foo');
    expect(normalizeTagName('Grün & Weiss')).toBe('grun-&-weiss');
  });

  it('liefert leer, wenn nichts Verwertbares uebrig bleibt', () => {
    expect(normalizeTagName('   ')).toBe('');
    expect(normalizeTagName('---')).toBe('');
  });

  it('entfernt Steuerzeichen', () => {
    expect(normalizeTagName(`health${NUL}tech`)).toBe('healthtech');
  });
});

describe('toFtsPrefixQuery', () => {
  it('macht aus jedem Token eine gequotete Praefix-Phrase', () => {
    expect(toFtsPrefixQuery('anna')).toBe('"anna"*');
    expect(toFtsPrefixQuery('anna schmidt')).toBe('"anna"* "schmidt"*');
  });

  it('entschaerft FTS5-Operatoren statt zu werfen', () => {
    for (const raw of [
      'AND',
      'OR NOT',
      'a OR b',
      'NEAR(a b, 3)',
      '*',
      'a*',
      '(',
      'a OR b) (',
      '"unclosed',
      '^foo',
      'x:y',
      '{name}',
      "o'brien",
      'well-known',
    ]) {
      expect(() => toFtsPrefixQuery(raw)).not.toThrow();
    }
  });

  it('liefert null, wenn kein Token uebrig bleibt', () => {
    expect(toFtsPrefixQuery('')).toBeNull();
    expect(toFtsPrefixQuery('   ')).toBeNull();
    expect(toFtsPrefixQuery('--- ()')).toBeNull();
    expect(toFtsPrefixQuery(NUL)).toBeNull();
  });

  it('entfernt Steuerzeichen aus den Tokens (sonst: unterminated string)', () => {
    expect(toFtsPrefixQuery(`abc${NUL}def`)).toBe('"abcdef"*');
    expect(toFtsPrefixQuery(`${NUL}abc`)).toBe('"abc"*');
    expect(toFtsPrefixQuery(`abc${NUL}`)).toBe('"abc"*');
  });

  it('baut niemals eine mehrwortige Phrase', () => {
    // Das ist die Schutzregel hinter dem Phrasen-Regressionstest in
    // tests/fts.regression.test.ts: needs_text/offers_text entstehen ueber
    // group_concat, eine echte Phrase koennte deshalb ueber die Grenze
    // zwischen zwei Needs hinweg matchen. Solange jedes Token einzeln
    // gequotet und implizit mit AND verknuepft wird, kann das nicht passieren.
    for (const raw of [
      'anna schmidt',
      '"Buchhaltung Software"',
      'sucht Buchhaltung Software fuer KMU',
      'a b c d e',
    ]) {
      const query = toFtsPrefixQuery(raw);
      expect(query).not.toBeNull();
      for (const part of (query ?? '').split(' ')) {
        // Jeder Teil ist eine Praefix-Phrase ...
        expect(part.startsWith('"'), part).toBe(true);
        expect(part.endsWith('"*'), part).toBe(true);
        // ... und enthaelt kein Whitespace. Genau daran scheitert eine
        // mehrwortige Phrase: ohne Leerzeichen im Phrasenkoerper kann sie
        // nicht ueber zwei Woerter reichen.
        expect(part, part).not.toMatch(/\s/);
      }
    }
  });
});

describe('Textbausteine', () => {
  it('normalizeText faltet Unicode, nicht nur ASCII', () => {
    expect(normalizeText('MÜNCHEN')).toBe(normalizeText('München'));
    expect(normalizeText('ŽABA')).toBe('zaba');
    expect(normalizeText('BERLIN')).toBe('berlin');
  });

  it('stripControlCharacters behaelt Tab und Zeilenumbruch', () => {
    expect(stripControlCharacters(`a${NUL}b`)).toBe('ab');
    expect(stripControlCharacters('Zeile 1\nZeile 2\tEnde')).toBe('Zeile 1\nZeile 2\tEnde');
  });

  it('stripSearchNoise laesst normale Zeichen unangetastet', () => {
    expect(stripSearchNoise('München')).toBe('München');
    expect(stripSearchNoise(`Mün${NUL}chen`)).toBe('München');
  });
});
