import { describe, expect, it } from 'vitest'

import { detectDelimiter, parseCsv, parseCsvRows } from './csv.ts'

describe('parseCsvRows', () => {
  it('reads the plain case', () => {
    expect(parseCsvRows('a,b\n1,2\n', ',')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('does not invent a final empty row from a trailing newline', () => {
    expect(parseCsvRows('a,b\n', ',')).toHaveLength(1)
    expect(parseCsvRows('a,b', ',')).toHaveLength(1)
  })

  it('keeps a delimiter that is inside quotes', () => {
    expect(parseCsvRows('a,"Meyer, Schulz & Partner",c', ',')).toEqual([
      ['a', 'Meyer, Schulz & Partner', 'c'],
    ])
  })

  it('reads a doubled quote as one literal quote', () => {
    expect(parseCsvRows('"she said ""no""",b', ',')).toEqual([['she said "no"', 'b']])
  })

  /** The LinkedIn fixture has one of these, in a job title. */
  it('reads a newline inside a quoted field as part of the value', () => {
    const rows = parseCsvRows('a,"Co-Founder & CEO\nAutonomous survey vessels",c\nd,e,f', ',')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.[1]).toBe('Co-Founder & CEO\nAutonomous survey vessels')
  })

  it('treats CRLF as one break and strips a byte-order mark', () => {
    expect(parseCsvRows('﻿a,b\r\n1,2\r\n', ',')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('preserves empty cells, including a leading and a trailing one', () => {
    expect(parseCsvRows(',b,', ',')).toEqual([['', 'b', '']])
  })

  it('yields a one-cell row for a blank line, which is what a preamble looks like', () => {
    expect(parseCsvRows('Notes:\n\na,b', ',')).toEqual([['Notes:'], [''], ['a', 'b']])
  })
})

describe('detectDelimiter', () => {
  it('finds the comma, the semicolon, the tab and the pipe', () => {
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',')
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';')
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t')
    expect(detectDelimiter('a|b|c\n1|2|3')).toBe('|')
  })

  /**
   * The case that rules out counting separators: a German export is semicolon-delimited and its
   * cells are full of commas, so the comma is the more frequent character by a wide margin and the
   * wrong answer. Consistency of row width is what distinguishes them.
   */
  it('prefers the delimiter that gives every row the same width, not the commonest character', () => {
    const text =
      'Name;Notiz\n' +
      'Anna Berger;Getroffen auf der Konferenz, sehr interessiert, meldet sich\n' +
      'Jonas Weber;Kennt Marta, Lukas und Ekaterina, will vorstellen\n'
    expect(detectDelimiter(text)).toBe(';')
  })

  it('falls back to the comma when the text has no delimiter at all', () => {
    expect(detectDelimiter('just one column\nand another line')).toBe(',')
  })

  it('is not derailed by a newline inside a quoted field', () => {
    const text = 'a;b\n"line one\nline two";second\n"third\nfourth";fifth\n'
    expect(detectDelimiter(text)).toBe(';')
  })
})

describe('parseCsv', () => {
  it('sniffs and parses in one step', () => {
    expect(parseCsv('a;b\n1;2')).toEqual({
      delimiter: ';',
      rows: [
        ['a', 'b'],
        ['1', '2'],
      ],
    })
  })
})
