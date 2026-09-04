import {
  ATTRIBUTE_TYPES,
  civil,
  decimal,
  type AttributeDefinitionDto,
  type AttributeType,
  type AttributeValue,
  type CivilDate,
  type DecimalString,
} from '@mutuals/core'
import { describe, expect, it } from 'vitest'

import {
  attributeTypeOf,
  coreOptions,
  isEmptyDraft,
  numberDisplayOf,
  relationConfigOf,
  toDraft,
  toWriteValue,
  validateDraft,
  type AttributeDraft,
} from './value.ts'

function defn(
  type: AttributeType,
  extra: Partial<AttributeDefinitionDto> = {},
): AttributeDefinitionDto {
  return {
    id: `00000000-0000-4000-8000-0000000000${String(ATTRIBUTE_TYPES.indexOf(type) + 10)}`,
    objectType: 'contact',
    title: type,
    slug: type,
    type,
    config: {},
    options: [],
    group: null,
    description: null,
    isSystem: false,
    isMulti: false,
    isDerived: false,
    sortable: true,
    position: 0,
    showByDefault: true,
    recordCount: 0,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...extra,
  }
}

function option(key: string, label: string, position: number, color: string | null = null) {
  return {
    id: `00000003-0000-4000-8000-00000003000${String(position)}`,
    key,
    label,
    color,
    position,
    archivedAt: null,
  }
}

const ORGANIZATION_ID = '375153a9-9ad0-4575-b8d3-c364ccc6de45'

const SELECT_OPTIONS = [option('founder', 'Founder', 0), option('investor', 'Investor', 1, 'blue')]

const RELATION_CONFIG = {
  targetObjectType: 'organization',
  cardinality: 'many',
  hasLinkMetadata: true,
}

/** One definition, one read value and the write payload it must produce, for all twelve types. */
const CASES: {
  [T in AttributeType]: {
    definition: AttributeDefinitionDto
    read: Extract<AttributeValue, { type: T }>
    draft: AttributeDraft<T>
    write: unknown
    /** A draft the attribute's own schema must refuse, and the message it must refuse it with. */
    invalid?: { draft: AttributeDraft<T>; message: string }
  }
} = {
  short_text: {
    definition: defn('short_text'),
    read: { type: 'short_text', value: 'Berlin' },
    draft: 'Berlin',
    write: 'Berlin',
  },
  long_text: {
    definition: defn('long_text'),
    read: { type: 'long_text', value: 'Came through the Founders Guild Slack.' },
    draft: 'Came through the Founders Guild Slack.',
    write: 'Came through the Founders Guild Slack.',
  },
  number: {
    definition: defn('number', { config: { unit: '€', decimals: 2 } }),
    read: { type: 'number', value: decimal('250000.50') },
    draft: decimal('250000.50'),
    write: '250000.50',
    invalid: { draft: 'a lot' as DecimalString, message: 'Enter a number like 1250 or 1250.50.' },
  },
  date: {
    definition: defn('date'),
    read: { type: 'date', value: civil('1991-11-03') },
    draft: civil('1991-11-03'),
    write: '1991-11-03',
    invalid: { draft: '03.11.1991' as CivilDate, message: 'Enter a date as YYYY-MM-DD.' },
  },
  yes_no: {
    definition: defn('yes_no'),
    read: { type: 'yes_no', value: false },
    draft: false,
    write: false,
  },
  single_select: {
    definition: defn('single_select', { options: SELECT_OPTIONS }),
    read: { type: 'single_select', value: { key: 'investor', label: 'Investor', color: 'blue' } },
    draft: 'investor',
    write: 'investor',
  },
  multi_select: {
    definition: defn('multi_select', { options: SELECT_OPTIONS, isMulti: true }),
    read: {
      type: 'multi_select',
      value: [
        { key: 'founder', label: 'Founder', color: null },
        { key: 'investor', label: 'Investor', color: 'blue' },
      ],
    },
    draft: ['founder', 'investor'],
    write: ['founder', 'investor'],
  },
  tags: {
    definition: defn('tags', { isMulti: true }),
    read: { type: 'tags', value: ['Energy', 'Open source'] },
    draft: ['Energy', 'Open source'],
    write: ['Energy', 'Open source'],
  },
  url: {
    definition: defn('url'),
    read: { type: 'url', value: 'https://www.linkedin.com/in/anna' },
    draft: 'https://www.linkedin.com/in/anna',
    write: 'https://www.linkedin.com/in/anna',
    invalid: {
      draft: 'not a url',
      message: 'Enter a web address, for example https://example.com.',
    },
  },
  email: {
    definition: defn('email'),
    read: { type: 'email', value: 'anna@example.com' },
    draft: 'anna@example.com',
    write: 'anna@example.com',
    invalid: {
      draft: 'not-an-email',
      message: 'Enter an email address, for example anna@example.com.',
    },
  },
  phone: {
    definition: defn('phone'),
    read: { type: 'phone', value: '+49160100462' },
    draft: '+49160100462',
    write: '+49160100462',
    invalid: { draft: 'call me', message: 'Enter a phone number.' },
  },
  relation: {
    definition: defn('relation', { config: RELATION_CONFIG, isMulti: true }),
    read: {
      type: 'relation',
      value: [
        {
          id: ORGANIZATION_ID,
          label: 'Nimbus Health',
          objectType: 'organization',
          title: 'Founder & CEO',
          from: civil('2024-10-14'),
          to: null,
          isPrimary: true,
        },
      ],
    },
    draft: [
      {
        id: ORGANIZATION_ID,
        label: 'Nimbus Health',
        objectType: 'organization',
        title: 'Founder & CEO',
        from: civil('2024-10-14'),
        to: null,
        isPrimary: true,
      },
    ],
    write: [
      {
        id: ORGANIZATION_ID,
        title: 'Founder & CEO',
        from: '2024-10-14',
        to: null,
        isPrimary: true,
      },
    ],
  },
}

/** A degenerate value of each type: present on the wire, but nothing a person would call a value. */
const DEGENERATE: { [T in AttributeType]: AttributeDraft<T> } = {
  short_text: '',
  long_text: '   ',
  number: '' as DecimalString,
  date: '' as CivilDate,
  // A boolean is never degenerate: `false` is an answer, and telling it from "not asked" is the
  // entire reason the type is nullable.
  yes_no: false,
  single_select: '',
  multi_select: [],
  tags: [],
  url: '',
  email: '',
  phone: '',
  relation: [],
}

const TYPES = ATTRIBUTE_TYPES

describe('the twelve types are all covered', () => {
  it('has a case for every type in the registry', () => {
    expect(Object.keys(CASES).sort()).toEqual([...TYPES].sort())
  })
})

describe('an empty value, of every type', () => {
  for (const type of TYPES) {
    it(`${type}: an absent value is empty and writes as null`, () => {
      const { definition } = CASES[type]
      expect(toDraft(undefined)).toBeUndefined()
      expect(isEmptyDraft(type, undefined)).toBe(true)
      expect(toWriteValue(type, undefined)).toBeNull()
      // ADR-017's empty is not a validation failure: clearing a field is a legal edit.
      expect(validateDraft(definition, undefined)).toBeUndefined()
    })

    it(`${type}: a degenerate draft is treated the same way`, () => {
      const draft = DEGENERATE[type]
      const expectedEmpty = type !== 'yes_no'
      expect(isEmptyDraft(type, draft)).toBe(expectedEmpty)
      expect(toWriteValue(type, draft) === null).toBe(expectedEmpty)
    })
  }
})

describe('read value to draft to write payload', () => {
  for (const type of TYPES) {
    it(`${type} round-trips`, () => {
      const { read, draft, write, definition } = CASES[type]
      expect(toDraft(read)).toEqual(draft)
      expect(toWriteValue(type, draft)).toEqual(write)
      expect(validateDraft(definition, draft)).toBeUndefined()
    })
  }
})

describe('validateDraft', () => {
  for (const type of TYPES) {
    const invalid = CASES[type].invalid
    if (invalid === undefined) continue
    it(`${type} reports the message its own schema in packages/core carries`, () => {
      expect(validateDraft(CASES[type].definition, invalid.draft)).toBe(invalid.message)
    })
  }

  it('refuses an option key that is not one of this attribute’s options', () => {
    const message = validateDraft(CASES.single_select.definition, 'angel')
    expect(message).toBeDefined()
  })

  it('accepts a select value chosen from the definition, not from a hard-coded list', () => {
    expect(validateDraft(CASES.single_select.definition, 'founder')).toBeUndefined()
  })
})

describe('toWriteValue for relations', () => {
  it('keeps the §4.3 link metadata rather than flattening a job history to an id', () => {
    expect(toWriteValue('relation', CASES.relation.draft)).toEqual(CASES.relation.write)
  })

  it('drops a title and a from date that were never set', () => {
    expect(
      toWriteValue('relation', [
        {
          id: ORGANIZATION_ID,
          label: 'Nimbus Health',
          objectType: 'organization',
          title: null,
          from: null,
          to: null,
          isPrimary: false,
        },
      ]),
    ).toEqual([{ id: ORGANIZATION_ID, to: null, isPrimary: false }])
  })
})

describe('reading a definition', () => {
  it('narrows the wire type, which the contract erases to string', () => {
    expect(attributeTypeOf(CASES.number.definition)).toBe('number')
    expect(() => attributeTypeOf(defn('short_text', { type: 'colour' }))).toThrow(/unknown type/)
  })

  it('reads the unit and decimals out of the config the user chose', () => {
    expect(numberDisplayOf(CASES.number.definition)).toEqual({ unit: '€', decimals: 2 })
    expect(numberDisplayOf(defn('number'))).toEqual({ unit: undefined, decimals: undefined })
  })

  it('reads a relation’s target and cardinality out of its config', () => {
    expect(relationConfigOf(CASES.relation.definition)).toEqual({
      targetObjectType: 'organization',
      cardinality: 'many',
      hasLinkMetadata: true,
    })
  })

  it('turns a null option colour into an absent one', () => {
    const [founder, investor] = coreOptions(CASES.single_select.definition)
    expect(founder).not.toHaveProperty('color')
    expect(investor?.color).toBe('blue')
  })
})
