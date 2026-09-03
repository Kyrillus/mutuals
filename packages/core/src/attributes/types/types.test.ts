/**
 * One table over all twelve attribute types, then the per-type cases that only matter for that
 * type. §8.1 names attribute validation as a thing that breaks silently, and the table is what
 * makes "every type behaves the same way about the same things" checkable rather than hoped for.
 */
import { describe, expect, it } from 'vitest'

import { unwrap } from '../../result.ts'
import type { AttributeOption } from '../option.ts'
import { ATTRIBUTE_TYPES, anyTypeDef, type AttributeType } from '../registry.ts'
import type { SlotValue } from '../kinds.ts'
import { codePointLength, splitMultiValue, textOf, type TypeContext } from './def.ts'
import { canonicalizeEmail } from './email.ts'
import { canonicalizeUrl } from './url.ts'
import { canonicalizePhone, digitsOf, looksLikePhone } from './phone.ts'
import { DEFAULT_MAX_LENGTH } from './short-text.ts'
import { MAX_TAG_LENGTH } from './tags.ts'

const OPTIONS: readonly AttributeOption[] = [
  { id: '11111111-1111-4111-8111-111111111111', key: 'investor', label: 'Investor', position: 0 },
  { id: '22222222-2222-4222-8222-222222222222', key: 'founder', label: 'Founder', position: 1 },
  {
    id: '33333333-3333-4333-8333-333333333333',
    key: 'angel',
    label: 'Angel',
    position: 2,
    archivedAt: '2026-01-01T00:00:00.000Z',
  },
]

const CTX: TypeContext = { options: OPTIONS }
const NO_OPTIONS: TypeContext = { options: [] }

const ORG_ID = '44444444-4444-4444-8444-444444444444'
const OTHER_ORG_ID = '55555555-5555-4555-8555-555555555555'

const RELATION_CONFIG = {
  targetObjectType: 'organization',
  cardinality: 'many',
  hasLinkMetadata: false,
}

interface TypeCase {
  readonly type: AttributeType
  readonly config: unknown
  readonly ctx: TypeContext
  readonly valid: readonly unknown[]
  readonly invalid: readonly unknown[]
  readonly coerces: readonly (readonly [string, unknown])[]
  readonly refuses: readonly string[]
}

const CASES: readonly TypeCase[] = [
  {
    type: 'short_text',
    config: {},
    ctx: CTX,
    valid: ['Munich', ' Munich ', 'x', 'a'.repeat(DEFAULT_MAX_LENGTH)],
    invalid: ['', '   ', 'a'.repeat(DEFAULT_MAX_LENGTH + 1), 42],
    coerces: [
      ['  Munich  ', 'Munich'],
      ['München', 'München'],
    ],
    refuses: ['', '   ', 'a'.repeat(DEFAULT_MAX_LENGTH + 1)],
  },
  {
    type: 'long_text',
    config: {},
    ctx: CTX,
    valid: ['Met at Bits & Pretzels', '# Heading\n\nBody', 'a'.repeat(10_000), 'x'],
    invalid: ['', '\n\n', 7, null],
    coerces: [['  a note  ', 'a note']],
    refuses: ['', '  '],
  },
  {
    type: 'number',
    config: {},
    ctx: CTX,
    valid: ['0', '250000.50', '-42', '100000000000000000000000000001'],
    invalid: ['', '1e9', '007', 'abc'],
    coerces: [
      ['1.234,56', '1234.56'],
      ['1,234.56', '1234.56'],
      ['1 234,56', '1234.56'],
      ["1'234.56", '1234.56'],
      ['  -7  ', '-7'],
    ],
    refuses: ['', '€1.2k', '1,234', '12%'],
  },
  {
    type: 'date',
    config: {},
    ctx: CTX,
    valid: ['2026-03-01', '2024-02-29', '1970-01-01', '2026-12-31'],
    invalid: ['2026-02-30', '01.03.2026', '2026-3-1', ''],
    coerces: [
      ['2026-03-01', '2026-03-01'],
      ['01.03.2026', '2026-03-01'],
      ['1.3.2026', '2026-03-01'],
      ['2026-03-01T10:15:00Z', '2026-03-01'],
    ],
    refuses: ['', '03/04/2026', '2026-02-30', 'yesterday'],
  },
  {
    type: 'yes_no',
    config: {},
    ctx: CTX,
    valid: [true, false],
    invalid: ['yes', 'true', 1, null],
    coerces: [
      ['yes', true],
      ['NO', false],
      ['1', true],
      ['ja', true],
      ['0', false],
    ],
    refuses: ['', 'maybe', 'vielleicht'],
  },
  {
    type: 'single_select',
    config: {},
    ctx: CTX,
    valid: ['investor', 'founder'],
    // `angel` is archived, so it cannot be chosen afresh even though it still resolves.
    invalid: ['angel', 'Investor', '', 3],
    coerces: [
      ['investor', 'investor'],
      ['Investor', 'investor'],
      ['  founder  ', 'founder'],
      ['FOUNDER', 'founder'],
    ],
    refuses: ['', 'Operator'],
  },
  {
    type: 'multi_select',
    config: {},
    ctx: CTX,
    valid: [['investor'], ['investor', 'founder']],
    invalid: [[], ['angel'], 'investor', [1]],
    coerces: [
      ['investor, founder', ['investor', 'founder']],
      ['Investor; Founder', ['investor', 'founder']],
      ['investor|investor', ['investor']],
    ],
    refuses: ['', 'operator', 'investor, operator'],
  },
  {
    type: 'tags',
    config: {},
    ctx: CTX,
    valid: [['climate tech'], ['climate tech', 'energy'], ['a'], ['a'.repeat(MAX_TAG_LENGTH)]],
    invalid: [[], [''], 'climate tech', ['a'.repeat(MAX_TAG_LENGTH + 1)]],
    coerces: [
      ['climate tech, energy', ['climate tech', 'energy']],
      ['Climate Tech; climate tech', ['Climate Tech']],
      [' a | b ', ['a', 'b']],
    ],
    refuses: ['', '  ', 'a'.repeat(MAX_TAG_LENGTH + 1)],
  },
  {
    type: 'url',
    config: {},
    ctx: CTX,
    valid: [
      'https://example.com/anna',
      'http://example.com',
      'linkedin.com/in/anna',
      'https://example.com/a?b=c#d',
    ],
    invalid: ['', 'not a url', 'ftp://example.com', 'https:// example.com'],
    coerces: [
      ['linkedin.com/in/anna', 'https://linkedin.com/in/anna'],
      ['  https://example.com  ', 'https://example.com'],
    ],
    refuses: ['', 'mailto:anna@example.com', 'ftp://example.com'],
  },
  {
    type: 'email',
    config: {},
    ctx: CTX,
    valid: ['anna@example.com', 'Anna.Berger@Example.COM', 'a+tag@sub.example.co.uk', ' a@b.io '],
    invalid: ['', 'anna@example', 'anna example.com', 'anna@@example.com'],
    coerces: [
      ['Anna@Example.com', 'anna@example.com'],
      ['mailto:anna@example.com', 'anna@example.com'],
    ],
    refuses: ['', 'anna', 'anna@'],
  },
  {
    type: 'phone',
    config: {},
    ctx: CTX,
    valid: ['+49 89 1234567', '089 1234567', '(089) 123-4567', '+1 415 555 2671'],
    invalid: ['', '1234', 'call me', '+49 89 1234567 ext 12'],
    coerces: [
      ['  +49 89 1234567  ', '+49 89 1234567'],
      ['089/1234567', '089/1234567'],
    ],
    refuses: ['', 'n/a', '12'],
  },
  {
    type: 'relation',
    config: RELATION_CONFIG,
    ctx: CTX,
    valid: [[{ id: ORG_ID }], [{ id: ORG_ID }, { id: OTHER_ORG_ID }]],
    invalid: [[], [{ id: 'northstar' }], ORG_ID, [{}]],
    coerces: [
      [ORG_ID, [{ id: ORG_ID }]],
      [`${ORG_ID}, ${OTHER_ORG_ID}`, [{ id: ORG_ID }, { id: OTHER_ORG_ID }]],
    ],
    refuses: ['Northstar Ventures', '', '   '],
  },
]

function slotsFor(testCase: TypeCase, input: unknown): readonly SlotValue[] {
  const definition = anyTypeDef(testCase.type)
  const parsed = definition.value(testCase.config, testCase.ctx).parse(input)
  return definition.normalize(parsed, testCase.config, testCase.ctx)
}

describe('every attribute type', () => {
  it('has a case in this table', () => {
    expect([...CASES.map((c) => c.type)].sort()).toEqual([...ATTRIBUTE_TYPES].sort())
  })

  it.each(CASES)('$type accepts the values its schema should accept', (testCase) => {
    const schema = anyTypeDef(testCase.type).value(testCase.config, testCase.ctx)
    for (const value of testCase.valid) {
      expect(schema.safeParse(value).success, JSON.stringify(value)).toBe(true)
    }
  })

  it.each(CASES)('$type rejects the values its schema should reject', (testCase) => {
    const schema = anyTypeDef(testCase.type).value(testCase.config, testCase.ctx)
    for (const value of testCase.invalid) {
      expect(schema.safeParse(value).success, JSON.stringify(value)).toBe(false)
    }
  })

  it.each(CASES)('$type normalises into its own slot kind', (testCase) => {
    const definition = anyTypeDef(testCase.type)
    for (const value of testCase.valid) {
      const slots = slotsFor(testCase, value)
      expect(slots.length).toBeGreaterThan(0)
      for (const slot of slots) expect(slot.kind).toBe(definition.valueKind)
    }
  })

  it.each(CASES)('$type normalises idempotently', (testCase) => {
    for (const value of testCase.valid) {
      expect(slotsFor(testCase, value)).toEqual(slotsFor(testCase, value))
    }
  })

  it.each(CASES)('$type survives a format → coerce → normalise round trip', (testCase) => {
    const definition = anyTypeDef(testCase.type)
    for (const value of testCase.valid) {
      const slots = slotsFor(testCase, value)
      const rendered = definition.format(slots, testCase.config, testCase.ctx)
      const back = definition.coerce(rendered, testCase.config, testCase.ctx)
      expect(back.ok, `${testCase.type}: ${rendered}`).toBe(true)
      const again = definition.normalize(unwrap(back), testCase.config, testCase.ctx)
      expect(again).toEqual(slots)
    }
  })

  it.each(CASES)('$type coerces the messy spellings a CSV produces', (testCase) => {
    const definition = anyTypeDef(testCase.type)
    for (const [raw, expected] of testCase.coerces) {
      const result = definition.coerce(raw, testCase.config, testCase.ctx)
      expect(result.ok, `${testCase.type}: ${raw}`).toBe(true)
      expect(unwrap(result), raw).toEqual(expected)
    }
  })

  it.each(CASES)('$type refuses rather than guesses', (testCase) => {
    const definition = anyTypeDef(testCase.type)
    for (const raw of testCase.refuses) {
      const result = definition.coerce(raw, testCase.config, testCase.ctx)
      expect(result.ok, `${testCase.type}: ${JSON.stringify(raw)}`).toBe(false)
    }
  })

  it.each(CASES)('$type formats an absent value as the empty string', (testCase) => {
    expect(anyTypeDef(testCase.type).format([], testCase.config, testCase.ctx)).toBe('')
  })

  it.each(CASES)('$type throws when handed a value that never passed its schema', (testCase) => {
    const definition = anyTypeDef(testCase.type)
    expect(() => definition.normalize(Symbol('nope'), testCase.config, testCase.ctx)).toThrow()
  })
})

describe('short_text', () => {
  it('honours a configured maximum', () => {
    const definition = anyTypeDef('short_text')
    expect(definition.value({ maxLength: 3 }, CTX).safeParse('abcd').success).toBe(false)
    expect(definition.value({ maxLength: 3 }, CTX).safeParse('abc').success).toBe(true)
    const tooLong = definition.coerce('abcd', { maxLength: 3 }, CTX)
    expect(tooLong.ok).toBe(false)
  })

  it('counts code points, not UTF-16 units, so an emoji is one character', () => {
    expect(codePointLength('👩‍🚀')).toBeLessThan('👩‍🚀'.length)
    expect(anyTypeDef('short_text').value({ maxLength: 1 }, CTX).safeParse('🚀').success).toBe(true)
  })
})

describe('number', () => {
  it('stores what the user typed and rounds only on the way out', () => {
    const definition = anyTypeDef('number')
    const slots = definition.normalize('250000.50', { decimals: 0 }, CTX)
    expect(slots).toEqual([{ kind: 'number', num: '250000.50' }])
    expect(definition.format(slots, { decimals: 0 }, CTX)).toBe('250001')
    expect(definition.format(slots, {}, CTX)).toBe('250000.50')
  })

  it('appends a configured unit', () => {
    const slots = anyTypeDef('number').normalize('1250', {}, CTX)
    expect(anyTypeDef('number').format(slots, { unit: 'EUR', decimals: 2 }, CTX)).toBe(
      '1250.00 EUR',
    )
  })

  it('names the bound it is complaining about', () => {
    const definition = anyTypeDef('number')
    const message = (config: unknown): string => {
      const result = definition.value(config, CTX).safeParse('500')
      return result.success ? '' : (result.error.issues[0]?.message ?? '')
    }
    expect(message({ min: '0', max: '100' })).toBe('Must be between 0 and 100.')
    expect(message({ min: '1000' })).toBe('Must be at least 1000.')
    expect(message({ max: '100' })).toBe('Must be at most 100.')
    expect(anyTypeDef('number').value({ min: '0' }, CTX).safeParse('500').success).toBe(true)
  })

  it('enforces configured bounds in both the schema and the coercion', () => {
    const config = { min: '0', max: '100' }
    expect(anyTypeDef('number').value(config, CTX).safeParse('101').success).toBe(false)
    expect(anyTypeDef('number').value(config, CTX).safeParse('100').success).toBe(true)
    expect(anyTypeDef('number').coerce('-1', config, CTX).ok).toBe(false)
    expect(anyTypeDef('number').coerce('50', { min: '0' }, CTX).ok).toBe(true)
    expect(anyTypeDef('number').coerce('50', { max: '100' }, CTX).ok).toBe(true)
  })
})

describe('date', () => {
  it('refuses a slash date instead of picking a reading', () => {
    const result = anyTypeDef('date').coerce('03/04/2026', {}, CTX)
    expect(result.ok).toBe(false)
    expect(result.ok ? [] : result.issues.map((i) => i.code)).toEqual(['ambiguous_date'])
  })

  it('rejects a dotted date that is not a real day', () => {
    expect(anyTypeDef('date').coerce('30.02.2026', {}, CTX).ok).toBe(false)
  })
})

describe('single_select', () => {
  it('still resolves an archived option, so an old value keeps rendering', () => {
    const definition = anyTypeDef('single_select')
    const slots = definition.normalize('angel', {}, CTX)
    expect(definition.format(slots, {}, CTX)).toBe('Angel')
  })

  it('refuses to offer anything when every option is gone', () => {
    expect(anyTypeDef('single_select').value({}, NO_OPTIONS).safeParse('investor').success).toBe(
      false,
    )
    expect(anyTypeDef('single_select').coerce('investor', {}, NO_OPTIONS).ok).toBe(false)
  })

  it('throws on an option key that never existed', () => {
    expect(() => anyTypeDef('single_select').normalize('operator', {}, CTX)).toThrow(
      /unknown option key/,
    )
  })

  it('falls back to the stored key when the option row has gone missing', () => {
    const orphan: readonly SlotValue[] = [
      { kind: 'option', optionId: '99999999-9999-4999-8999-999999999999', optionKey: 'gone' },
    ]
    expect(anyTypeDef('single_select').format(orphan, {}, CTX)).toBe('gone')
  })
})

describe('multi_select', () => {
  it('reports the position of each bad element', () => {
    const result = anyTypeDef('multi_select').coerce('investor, operator', {}, CTX)
    expect(result.ok).toBe(false)
    expect(result.ok ? [] : result.issues.map((i) => i.path)).toEqual([[1]])
  })

  it('drops a repeated option instead of writing it twice', () => {
    expect(anyTypeDef('multi_select').normalize(['investor', 'investor'], {}, CTX)).toHaveLength(1)
  })

  it('throws on a non-string element and on an unknown key', () => {
    expect(() => anyTypeDef('multi_select').normalize([1], {}, CTX)).toThrow(/option keys/)
    expect(() => anyTypeDef('multi_select').normalize(['operator'], {}, CTX)).toThrow(
      /unknown option key/,
    )
  })

  it('renders labels, the stored key for a missing option, and nothing for another kind', () => {
    const definition = anyTypeDef('multi_select')
    const slots: readonly SlotValue[] = [
      ...definition.normalize(['investor'], {}, CTX),
      { kind: 'option', optionId: 'x', optionKey: 'gone' },
      { kind: 'bool', bool: false },
    ]
    expect(definition.format(slots, {}, CTX)).toBe('Investor, gone')
  })
})

describe('tags', () => {
  it('keeps the first spelling and drops a case-only repeat', () => {
    expect(anyTypeDef('tags').normalize(['Climate Tech', 'climate tech'], {}, CTX)).toEqual([
      { kind: 'text', text: 'Climate Tech' },
    ])
  })

  it('drops blanks rather than writing an empty tag', () => {
    expect(anyTypeDef('tags').normalize(['  ', 'energy'], {}, CTX)).toEqual([
      { kind: 'text', text: 'energy' },
    ])
  })

  it('throws on a non-string element', () => {
    expect(() => anyTypeDef('tags').normalize([{}], {}, CTX)).toThrow(/array of strings/)
  })
})

describe('url', () => {
  it('adds a scheme but changes nothing else', () => {
    expect(canonicalizeUrl('example.com/a/')).toBe('https://example.com/a/')
    expect(canonicalizeUrl('https://example.com/a')).toBe('https://example.com/a')
  })

  it('refuses anything that is not http or https', () => {
    expect(canonicalizeUrl('ftp://example.com')).toBeUndefined()
    expect(canonicalizeUrl('mailto:a@b.io')).toBeUndefined()
    expect(canonicalizeUrl('https://')).toBeUndefined()
    expect(canonicalizeUrl('   ')).toBeUndefined()
  })

  it('throws when normalise is handed a value the schema would have refused', () => {
    expect(() => anyTypeDef('url').normalize('not a url', {}, CTX)).toThrow(/not a URL/)
  })
})

describe('email', () => {
  it('lower-cases, because the identifier table is unique on the lower-cased address', () => {
    expect(canonicalizeEmail('Anna.Berger@Example.COM')).toBe('anna.berger@example.com')
  })

  it('refuses an address with no dotted domain, and an over-long one', () => {
    expect(canonicalizeEmail('anna@localhost')).toBeUndefined()
    expect(canonicalizeEmail(`${'a'.repeat(250)}@example.com`)).toBeUndefined()
  })

  it('throws when normalise is handed a value the schema would have refused', () => {
    expect(() => anyTypeDef('email').normalize('anna', {}, CTX)).toThrow(/not an email/)
  })
})

describe('phone', () => {
  it('keeps the typed value when no normaliser is injected — the browser case', () => {
    expect(canonicalizePhone(' 089 1234567 ', { options: [] })).toBe('089 1234567')
  })

  it('uses the injected normaliser and the profile region when there is one', () => {
    const seen: string[] = []
    const ctx: TypeContext = {
      options: [],
      phoneRegion: 'DE',
      normalizePhone: (raw, region) => {
        seen.push(`${raw}|${region ?? '-'}`)
        return '+49891234567'
      },
    }
    expect(anyTypeDef('phone').normalize('089 1234567', {}, ctx)).toEqual([
      { kind: 'text', text: '+49891234567' },
    ])
    expect(seen).toEqual(['089 1234567|DE'])
  })

  it('falls back to the typed value when the normaliser cannot parse it', () => {
    const ctx: TypeContext = { options: [], normalizePhone: () => undefined }
    expect(canonicalizePhone('089 1234567', ctx)).toBe('089 1234567')
  })

  it('counts digits, not characters', () => {
    expect(digitsOf('+49 (89) 123-4567')).toBe('49891234567')
    expect(looksLikePhone('+49 (89) 123-4567')).toBe(true)
    expect(looksLikePhone('1234')).toBe(false)
    expect(looksLikePhone('1'.repeat(18))).toBe(false)
  })
})

describe('relation', () => {
  it('carries link metadata only when the attribute is configured for it', () => {
    const withMetadata = { ...RELATION_CONFIG, hasLinkMetadata: true }
    const input = [
      { id: ORG_ID, title: 'Co-Founder', from: '2023-06-01', to: null, isPrimary: true },
    ]
    expect(anyTypeDef('relation').normalize(input, withMetadata, CTX)).toEqual([
      {
        kind: 'relation',
        targetRecordId: ORG_ID,
        link: { title: 'Co-Founder', from: '2023-06-01', to: null, isPrimary: true },
      },
    ])
    expect(anyTypeDef('relation').normalize(input, RELATION_CONFIG, CTX)).toEqual([
      { kind: 'relation', targetRecordId: ORG_ID },
    ])
  })

  it('omits the link when the attribute allows metadata but the value carries none', () => {
    const withMetadata = { ...RELATION_CONFIG, hasLinkMetadata: true }
    expect(anyTypeDef('relation').normalize([{ id: ORG_ID }], withMetadata, CTX)).toEqual([
      { kind: 'relation', targetRecordId: ORG_ID },
    ])
  })

  it('enforces one-or-many from the config, in the schema and in the coercion', () => {
    const one = { ...RELATION_CONFIG, cardinality: 'one' }
    const two = [{ id: ORG_ID }, { id: OTHER_ORG_ID }]
    expect(anyTypeDef('relation').value(one, CTX).safeParse(two).success).toBe(false)
    expect(anyTypeDef('relation').coerce(`${ORG_ID}, ${OTHER_ORG_ID}`, one, CTX).ok).toBe(false)
    expect(() => anyTypeDef('relation').normalize(two, one, CTX)).toThrow(/one-to-one/)
  })

  it('drops a repeated target from a single imported cell', () => {
    const result = anyTypeDef('relation').coerce(`${ORG_ID}; ${ORG_ID}`, RELATION_CONFIG, CTX)
    expect(unwrap(result)).toEqual([{ id: ORG_ID }])
  })

  it('renders only relation slots', () => {
    const mixed: readonly SlotValue[] = [
      { kind: 'relation', targetRecordId: ORG_ID },
      { kind: 'bool', bool: true },
    ]
    expect(anyTypeDef('relation').format(mixed, RELATION_CONFIG, CTX)).toBe(ORG_ID)
  })

  it('drops a repeated target', () => {
    expect(
      anyTypeDef('relation').normalize([{ id: ORG_ID }, { id: ORG_ID }], RELATION_CONFIG, CTX),
    ).toHaveLength(1)
  })

  it('says to pick the record rather than typing its name', () => {
    const result = anyTypeDef('relation').coerce('Northstar Ventures', RELATION_CONFIG, CTX)
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.issues[0]?.message).toMatch(/Pick the record/)
  })
})

describe('shared helpers', () => {
  it('splits a cell on any of the three separators and drops the blanks', () => {
    expect(splitMultiValue('a, b; c | d ,, e')).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(splitMultiValue('   ')).toEqual([])
  })

  it('reads text out of text slots and ignores the rest', () => {
    expect(
      textOf([
        { kind: 'text', text: 'a' },
        { kind: 'bool', bool: true },
      ]),
    ).toEqual(['a'])
  })
})
