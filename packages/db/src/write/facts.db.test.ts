/**
 * The write path against a real database.
 *
 * The first test in this file is the one the whole design of `facts.ts` exists for: editing the
 * same field twice in a row. A version of `setValue` written as four sibling data-modifying CTEs
 * reads perfectly and passes the first edit; the second one fails with a duplicate key on
 * `fact_live_uq`, because sibling `WITH` statements share one snapshot and the supersession is
 * therefore invisible to the insert. `fact_live_uq` is partial and so cannot be `DEFERRABLE`, so
 * there is no way to relax the constraint either. If that test ever goes red, the fix is not to
 * loosen the index.
 */
import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import { civil, type SlotValue, type Uuid } from '@mutuals/core'
import {
  attributeIdBySlug,
  optionIdByKey,
  testDb,
  TEST_WORKSPACE_ID,
} from '../test-support/index.ts'
import { createAttributeDefinition } from '../repositories/attributes.ts'
import { valueHistory } from '../repositories/records.ts'
import { createContact, createOrganization } from './records.ts'
import {
  addElement,
  applyValues,
  clearAttribute,
  removeElement,
  setValue,
  setValues,
} from './facts.ts'
import { WriteError, type Provenance } from './types.ts'

const MANUAL: Provenance = { source: 'manual' }
const text = (value: string): SlotValue => ({ kind: 'text', text: value })

let contact: Uuid

beforeEach(async () => {
  contact = await createContact(testDb(), { firstName: 'Anna', lastName: 'Berger' })
})

interface FactRow {
  id: string
  value_key: string
  text_value: string | null
  option_id: string | null
  target_record_id: string | null
  superseded_by_id: string | null
  removed_at: Date | null
  removed_source: string | null
  source: string
}

async function facts(attributeId: Uuid, recordId: Uuid = contact): Promise<FactRow[]> {
  const rows = await sql<FactRow>`
    select id, value_key, text_value, option_id, target_record_id,
           superseded_by_id, removed_at, removed_source, source
      from fact
     where record_id = ${recordId} and attribute_id = ${attributeId}
     order by created_at, id
  `.execute(testDb())
  return rows.rows
}

async function values(attributeId: Uuid, recordId: Uuid = contact) {
  return testDb()
    .selectFrom('attribute_value')
    .select(['value_key', 'position', 'fact_id', 'text_value', 'text_norm', 'option_id'])
    .where('record_id', '=', recordId)
    .where('attribute_id', '=', attributeId)
    .orderBy('position')
    .execute()
}

describe('setValue', () => {
  it('edits the same field twice in a row', async () => {
    const city = await attributeIdBySlug('contact', 'city')

    await setValue(testDb(), {
      recordId: contact,
      attributeId: city,
      value: text('Berlin'),
      provenance: MANUAL,
    })
    await setValue(testDb(), {
      recordId: contact,
      attributeId: city,
      value: text('Munich'),
      provenance: MANUAL,
    })
    await setValue(testDb(), {
      recordId: contact,
      attributeId: city,
      value: text('Hamburg'),
      provenance: MANUAL,
    })

    const rows = await facts(city)
    expect(rows).toHaveLength(3)
    expect(rows.filter((row) => row.superseded_by_id === null)).toHaveLength(1)
    expect(await values(city)).toEqual([
      expect.objectContaining({ value_key: '', text_value: 'Hamburg', text_norm: 'hamburg' }),
    ])
  })

  it('leaves the superseded fact pointing at the row that replaced it', async () => {
    const city = await attributeIdBySlug('contact', 'city')
    const first = await setValue(testDb(), {
      recordId: contact,
      attributeId: city,
      value: text('Berlin'),
      provenance: { source: 'import', sourceRef: 'batch-1', confidence: 0.6 },
    })
    const second = await setValue(testDb(), {
      recordId: contact,
      attributeId: city,
      value: text('Munich'),
      provenance: MANUAL,
    })

    const rows = await facts(city)
    expect(rows.find((row) => row.id === first)?.superseded_by_id).toBe(second)
    expect(rows.find((row) => row.id === second)?.superseded_by_id).toBeNull()

    // The history is the whole point of the append-only log: the old value, its provenance and its
    // confidence are all still readable after the edit.
    const history = await valueHistory(testDb(), contact, city)
    expect(history.map((entry) => [entry.text, entry.source, entry.isCurrent])).toEqual(
      expect.arrayContaining([
        ['Munich', 'manual', true],
        ['Berlin', 'import', false],
      ]),
    )
    expect(history.find((entry) => entry.text === 'Berlin')?.confidence).toBe('0.60')
    expect(history.find((entry) => entry.text === 'Berlin')?.sourceRef).toBe('batch-1')
  })

  it('writes an empty value_key, which is what makes one index express both cardinalities', async () => {
    const city = await attributeIdBySlug('contact', 'city')
    await setValue(testDb(), {
      recordId: contact,
      attributeId: city,
      value: text('Berlin'),
      provenance: MANUAL,
    })

    expect((await facts(city)).map((row) => row.value_key)).toEqual([''])
    expect((await values(city)).map((row) => row.value_key)).toEqual([''])
  })

  it('refuses a multi-valued attribute', async () => {
    const tags = await attributeIdBySlug('contact', 'areas_of_interest')
    await expect(
      setValue(testDb(), {
        recordId: contact,
        attributeId: tags,
        value: text('climate'),
        provenance: MANUAL,
      }),
    ).rejects.toBeInstanceOf(WriteError)
  })

  it('refuses an attribute that belongs to another object type', async () => {
    const organizationCity = await attributeIdBySlug('organization', 'city')
    await expect(
      setValue(testDb(), {
        recordId: contact,
        attributeId: organizationCity,
        value: text('Berlin'),
        provenance: MANUAL,
      }),
    ).rejects.toThrow(/is a contact/)
  })
})

describe('a multi-valued attribute', () => {
  it('adds elements, and both stay live', async () => {
    const tags = await attributeIdBySlug('contact', 'areas_of_interest')
    await addElement(testDb(), {
      recordId: contact,
      attributeId: tags,
      value: text('Climate'),
      provenance: MANUAL,
    })
    await addElement(testDb(), {
      recordId: contact,
      attributeId: tags,
      value: text('Biotech'),
      provenance: MANUAL,
    })

    const rows = await facts(tags)
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.superseded_by_id === null)).toBe(true)
    expect((await values(tags)).map((row) => [row.position, row.text_value])).toEqual([
      [0, 'Biotech'],
      [1, 'Climate'],
    ])
  })

  it('keys a tag by its normalised text (ADR-018)', async () => {
    const tags = await attributeIdBySlug('contact', 'areas_of_interest')
    await addElement(testDb(), {
      recordId: contact,
      attributeId: tags,
      value: text('  Éducation  '),
      provenance: MANUAL,
    })

    expect((await facts(tags)).map((row) => row.value_key)).toEqual(['education'])
  })

  it('treats two spellings of one tag as one value', async () => {
    const tags = await attributeIdBySlug('contact', 'areas_of_interest')
    await addElement(testDb(), {
      recordId: contact,
      attributeId: tags,
      value: text('Climate'),
      provenance: MANUAL,
    })
    await addElement(testDb(), {
      recordId: contact,
      attributeId: tags,
      value: text('climate'),
      provenance: MANUAL,
    })

    const rows = await facts(tags)
    expect(rows).toHaveLength(2)
    expect(rows.filter((row) => row.superseded_by_id === null)).toHaveLength(1)
    expect((await values(tags)).map((row) => row.text_value)).toEqual(['climate'])
  })

  it('keys a multi_select element by the option key', async () => {
    const definition = await createAttributeDefinition(testDb(), {
      objectType: 'contact',
      title: 'Communities',
      slug: 'communities',
      type: 'multi_select',
      options: [
        { key: 'yc', label: 'Y Combinator' },
        { key: 'ef', label: 'Entrepreneur First' },
      ],
    })
    const yc = await optionIdByKey(definition.id, 'yc')
    const ef = await optionIdByKey(definition.id, 'ef')

    await addElement(testDb(), {
      recordId: contact,
      attributeId: definition.id,
      value: { kind: 'option', optionId: yc, optionKey: 'yc' },
      provenance: MANUAL,
    })
    await addElement(testDb(), {
      recordId: contact,
      attributeId: definition.id,
      value: { kind: 'option', optionId: ef, optionKey: 'ef' },
      provenance: MANUAL,
    })

    expect((await facts(definition.id)).map((row) => row.value_key).sort()).toEqual(['ef', 'yc'])
    expect((await values(definition.id)).map((row) => row.option_id).sort()).toEqual(
      [ef, yc].sort(),
    )
  })

  it('removes an element by writing a tombstone, never a DELETE', async () => {
    const tags = await attributeIdBySlug('contact', 'areas_of_interest')
    await addElement(testDb(), {
      recordId: contact,
      attributeId: tags,
      value: text('Climate'),
      provenance: MANUAL,
    })
    await addElement(testDb(), {
      recordId: contact,
      attributeId: tags,
      value: text('Biotech'),
      provenance: MANUAL,
    })

    const removed = await removeElement(testDb(), {
      recordId: contact,
      attributeId: tags,
      value: text('Climate'),
      provenance: { source: 'agent' },
    })
    expect(removed).toBe(true)

    const rows = await facts(tags)
    expect(rows).toHaveLength(3)

    const tombstone = rows.find((row) => row.removed_at !== null)
    expect(tombstone).toMatchObject({
      value_key: 'climate',
      text_value: 'Climate',
      removed_source: 'agent',
    })
    // The tombstone stays live: it occupies the slot, which is what makes a re-add a supersession.
    expect(tombstone?.superseded_by_id).toBeNull()
    expect((await values(tags)).map((row) => row.text_value)).toEqual(['Biotech'])
  })

  it('reads added → removed → added again after a re-add', async () => {
    const tags = await attributeIdBySlug('contact', 'areas_of_interest')
    await addElement(testDb(), {
      recordId: contact,
      attributeId: tags,
      value: text('Climate'),
      provenance: MANUAL,
    })
    await removeElement(testDb(), {
      recordId: contact,
      attributeId: tags,
      value: text('Climate'),
      provenance: MANUAL,
    })
    await addElement(testDb(), {
      recordId: contact,
      attributeId: tags,
      value: text('Climate'),
      provenance: MANUAL,
    })

    const rows = await facts(tags)
    expect(rows).toHaveLength(3)
    expect(rows.filter((row) => row.superseded_by_id === null)).toHaveLength(1)
    expect(rows.filter((row) => row.removed_at !== null)).toHaveLength(1)
    expect((await values(tags)).map((row) => row.text_value)).toEqual(['Climate'])
  })

  it('reports false when there was nothing to remove', async () => {
    const tags = await attributeIdBySlug('contact', 'areas_of_interest')
    const removed = await removeElement(testDb(), {
      recordId: contact,
      attributeId: tags,
      value: text('Climate'),
      provenance: MANUAL,
    })
    expect(removed).toBe(false)
  })
})

describe('setValues', () => {
  it('touches only what changed', async () => {
    const tags = await attributeIdBySlug('contact', 'areas_of_interest')
    await setValues(testDb(), {
      recordId: contact,
      attributeId: tags,
      values: [text('Climate'), text('Biotech')],
      provenance: MANUAL,
    })
    const before = await values(tags)

    await setValues(testDb(), {
      recordId: contact,
      attributeId: tags,
      values: [text('Climate'), text('Space')],
      provenance: MANUAL,
    })
    const after = await values(tags)

    const climateBefore = before.find((row) => row.value_key === 'climate')
    const climateAfter = after.find((row) => row.value_key === 'climate')
    // Re-saving a form must not fill the history popover with remove/add pairs for untouched
    // values, and the fact id is what proves nothing was rewritten.
    expect(climateAfter?.fact_id).toBe(climateBefore?.fact_id)
    expect(after.map((row) => row.text_value).sort()).toEqual(['Climate', 'Space'])
    expect((await facts(tags)).filter((row) => row.removed_at !== null)).toHaveLength(1)
  })

  it('clears the attribute when the set is empty', async () => {
    const tags = await attributeIdBySlug('contact', 'areas_of_interest')
    await setValues(testDb(), {
      recordId: contact,
      attributeId: tags,
      values: [text('Climate')],
      provenance: MANUAL,
    })
    await setValues(testDb(), {
      recordId: contact,
      attributeId: tags,
      values: [],
      provenance: MANUAL,
    })

    expect(await values(tags)).toEqual([])
    expect((await facts(tags)).filter((row) => row.removed_at !== null)).toHaveLength(1)
  })

  it('routes a single-valued attribute to setValue', async () => {
    const city = await attributeIdBySlug('contact', 'city')
    await setValues(testDb(), {
      recordId: contact,
      attributeId: city,
      values: [text('Berlin')],
      provenance: MANUAL,
    })
    await setValues(testDb(), {
      recordId: contact,
      attributeId: city,
      values: [text('Munich')],
      provenance: MANUAL,
    })

    expect((await values(city)).map((row) => row.text_value)).toEqual(['Munich'])
    expect(await facts(city)).toHaveLength(2)
  })
})

describe('clearAttribute', () => {
  it('writes one tombstone per live value and no DELETE', async () => {
    const tags = await attributeIdBySlug('contact', 'areas_of_interest')
    await addElement(testDb(), {
      recordId: contact,
      attributeId: tags,
      value: text('Climate'),
      provenance: MANUAL,
    })
    await addElement(testDb(), {
      recordId: contact,
      attributeId: tags,
      value: text('Biotech'),
      provenance: MANUAL,
    })

    const cleared = await clearAttribute(testDb(), {
      recordId: contact,
      attributeId: tags,
      provenance: MANUAL,
    })

    expect(cleared).toBe(2)
    expect(await facts(tags)).toHaveLength(4)
    expect(await values(tags)).toEqual([])
  })
})

describe('applyValues', () => {
  it('writes several attributes of one record in one transaction', async () => {
    const city = await attributeIdBySlug('contact', 'city')
    const tags = await attributeIdBySlug('contact', 'areas_of_interest')
    const birthday = await attributeIdBySlug('contact', 'birthday')

    await applyValues(testDb(), {
      recordId: contact,
      changes: [
        { attributeId: city, values: [text('Berlin')] },
        { attributeId: tags, values: [text('Climate'), text('Biotech')] },
        { attributeId: birthday, values: [{ kind: 'date', date: civil('1990-03-01') }] },
      ],
      provenance: MANUAL,
    })

    expect((await values(city)).map((row) => row.text_value)).toEqual(['Berlin'])
    expect(await values(tags)).toHaveLength(2)

    const stored = await testDb()
      .selectFrom('attribute_value')
      .select('date_value')
      .where('record_id', '=', contact)
      .where('attribute_id', '=', birthday)
      .executeTakeFirstOrThrow()
    // A calendar day is handed through as a string, so it cannot drift a day west of Greenwich.
    expect(stored.date_value).toBe('1990-03-01')
  })

  it('clears an attribute when the change carries null', async () => {
    const city = await attributeIdBySlug('contact', 'city')
    await setValue(testDb(), {
      recordId: contact,
      attributeId: city,
      value: text('Berlin'),
      provenance: MANUAL,
    })

    await applyValues(testDb(), {
      recordId: contact,
      changes: [{ attributeId: city, values: null }],
      provenance: MANUAL,
    })

    expect(await values(city)).toEqual([])
  })
})

describe('a relation', () => {
  it('is projected into record_link with its link metadata', async () => {
    const organization = await createOrganization(testDb(), { name: 'Northstar Ventures' })
    const relation = await attributeIdBySlug('contact', 'organization')

    await addElement(testDb(), {
      recordId: contact,
      attributeId: relation,
      value: {
        kind: 'relation',
        targetRecordId: organization,
        link: { title: 'Partner', from: civil('2024-01-01'), to: null, isPrimary: true },
      },
      provenance: MANUAL,
    })

    const links = await testDb()
      .selectFrom('record_link')
      .select(['to_record_id', 'title', 'valid_from', 'valid_to', 'is_primary'])
      .where('from_record_id', '=', contact)
      .execute()

    expect(links).toEqual([
      {
        to_record_id: organization,
        title: 'Partner',
        valid_from: '2024-01-01',
        valid_to: null,
        is_primary: true,
      },
    ])
    // Relations never reach `attribute_value`: the link carries its own attributes.
    expect(await values(relation)).toEqual([])
  })

  it('keys two live relations by their target, so a contact can have two organizations', async () => {
    const relation = await attributeIdBySlug('contact', 'organization')
    const first = await createOrganization(testDb(), { name: 'Northstar Ventures' })
    const second = await createOrganization(testDb(), { name: 'Tessellate' })

    for (const target of [first, second]) {
      await addElement(testDb(), {
        recordId: contact,
        attributeId: relation,
        value: { kind: 'relation', targetRecordId: target },
        provenance: MANUAL,
      })
    }

    const rows = await facts(relation)
    expect(rows.filter((row) => row.superseded_by_id === null)).toHaveLength(2)
    expect(rows.map((row) => row.value_key).sort()).toEqual([first, second].sort())
  })
})

describe('identifier write-through', () => {
  it('stores an email in its canonical form', async () => {
    const email = await attributeIdBySlug('contact', 'email')
    await setValue(testDb(), {
      recordId: contact,
      attributeId: email,
      value: text('  Anna.Berger+CRM@Example.COM '),
      provenance: MANUAL,
    })

    const rows = await testDb()
      .selectFrom('identifier')
      .select(['kind', 'value', 'source'])
      .where('record_id', '=', contact)
      .execute()

    expect(rows).toContainEqual({
      kind: 'email',
      value: 'anna.berger+crm@example.com',
      source: 'manual',
    })
  })

  it('stores a LinkedIn profile as in/<slug> and a website as its host (ADR-042)', async () => {
    const linkedin = await attributeIdBySlug('contact', 'linkedin_url')
    const website = await attributeIdBySlug('contact', 'website')

    await setValue(testDb(), {
      recordId: contact,
      attributeId: linkedin,
      value: text('https://www.linkedin.com/in/anna-berger/?originalSubdomain=de'),
      provenance: MANUAL,
    })
    await setValue(testDb(), {
      recordId: contact,
      attributeId: website,
      value: text('https://WWW.Example.com/about?utm_source=x'),
      provenance: MANUAL,
    })

    const rows = await testDb()
      .selectFrom('identifier')
      .select(['kind', 'value'])
      .where('record_id', '=', contact)
      .execute()

    // The projector also writes the whole normalised string for these two kinds; what is asserted
    // here is that the canonical identity is present, because that is what a duplicate probe uses.
    expect(rows).toContainEqual({ kind: 'linkedin_url', value: 'in/anna-berger' })
    expect(rows).toContainEqual({ kind: 'website', value: 'example.com' })
  })

  it('normalises a national phone number through the profile region (ADR-045)', async () => {
    await testDb()
      .insertInto('profile')
      .values({
        workspace_id: TEST_WORKSPACE_ID,
        first_name: 'Simon',
        last_name: 'Fuhrbach',
        phone_region: 'DE',
      })
      .execute()

    const phone = await attributeIdBySlug('contact', 'phone')
    await setValue(testDb(), {
      recordId: contact,
      attributeId: phone,
      value: text('089 1234567'),
      provenance: MANUAL,
    })

    const rows = await testDb()
      .selectFrom('identifier')
      .select('value')
      .where('record_id', '=', contact)
      .where('kind', '=', 'phone')
      .execute()

    expect(rows.map((row) => row.value)).toContain('+49891234567')
  })

  it('keeps a value that will not normalise, and refuses it as an identifier', async () => {
    const email = await attributeIdBySlug('contact', 'email')
    await setValue(testDb(), {
      recordId: contact,
      attributeId: email,
      value: text('not-an-email'),
      provenance: MANUAL,
    })

    expect((await values(email)).map((row) => row.text_value)).toEqual(['not-an-email'])

    const rows = await testDb()
      .selectFrom('identifier')
      .select('value')
      .where('record_id', '=', contact)
      .where('kind', '=', 'email')
      .execute()

    // Both write-throughs decline, and for the same reason. `writeIdentifiers` declines because
    // `not-an-email` has no canonical form; the projector declines because migration 0008 added
    // `mutuals_identifier_plausible()` to step 3. Before that migration the projector wrote
    // `text_norm` for every email, phone, linkedin_url and website value, valid or not — so two
    // contacts whose email field said "n/a" became identifier twins scoring 0.97, which is
    // ADR-042's `certain` band, the one band that needs no human judgement.
    //
    // The predicate is not a second normaliser and does not violate ADR-019: it decides only
    // whether a value is an identity claim at all, never what its canonical form is.
    expect(rows).toEqual([])

    // The value itself is untouched — it is still what the user typed, and still the current value
    // of the attribute. Only its promotion to an identity claim was refused.
    expect((await values(email)).map((row) => row.text_value)).toEqual(['not-an-email'])
  })

  it('accumulates every handle ever seen, including superseded ones (§4.6)', async () => {
    const email = await attributeIdBySlug('contact', 'email')
    await setValue(testDb(), {
      recordId: contact,
      attributeId: email,
      value: text('old@example.com'),
      provenance: MANUAL,
    })
    await setValue(testDb(), {
      recordId: contact,
      attributeId: email,
      value: text('new@example.com'),
      provenance: MANUAL,
    })

    const rows = await testDb()
      .selectFrom('identifier')
      .select('value')
      .where('record_id', '=', contact)
      .where('kind', '=', 'email')
      .execute()

    expect(rows.map((row) => row.value).sort()).toEqual(['new@example.com', 'old@example.com'])
  })
})

describe('the composite foreign key', () => {
  /**
   * The write path takes `value_kind` and `is_multi` from the definition row, so it cannot itself
   * violate `fact_shape_fk`. What the constraint protects against is everything else that can
   * write this table — the MCP server, an import script, a hand-run `psql` session — and a change
   * to an attribute's shape while values exist. Both are exercised through the query builder.
   */
  it('rejects a fact whose value_kind disagrees with its definition', async () => {
    const city = await attributeIdBySlug('contact', 'city')

    await expect(
      testDb()
        .insertInto('fact')
        .values({
          id: randomUUID(),
          workspace_id: TEST_WORKSPACE_ID,
          object_type: 'contact',
          record_id: contact,
          attribute_id: city,
          // `city` is a short_text, so its definition row is (city, 'text', false).
          value_kind: 'number',
          is_multi: false,
          num_value: '42',
          value_key: '',
          valid_from: '2026-01-01',
          source: 'manual',
        })
        .execute(),
    ).rejects.toMatchObject({ code: '23503', constraint: 'fact_shape_fk' })
  })

  it('refuses to change an attribute’s shape while a fact exists', async () => {
    const city = await attributeIdBySlug('contact', 'city')
    await setValue(testDb(), {
      recordId: contact,
      attributeId: city,
      value: text('Berlin'),
      provenance: MANUAL,
    })

    await expect(
      testDb()
        .updateTable('attribute_definition')
        .set({ type: 'number', value_kind: 'number' })
        .where('id', '=', city)
        .execute(),
    ).rejects.toMatchObject({ code: '23503' })
  })

  it('rejects a value written into the wrong slot', async () => {
    const birthday = await attributeIdBySlug('contact', 'birthday')

    await expect(
      setValue(testDb(), {
        recordId: contact,
        attributeId: birthday,
        value: text('not a date'),
        provenance: MANUAL,
      }),
    ).rejects.toMatchObject({ code: '23514', constraint: 'fact_slot' })
  })
})

describe('two concurrent writers', () => {
  it('serialise on the record lock and leave exactly one live fact', async () => {
    const city = await attributeIdBySlug('contact', 'city')

    await Promise.all([
      setValue(testDb(), {
        recordId: contact,
        attributeId: city,
        value: text('Berlin'),
        provenance: MANUAL,
      }),
      setValue(testDb(), {
        recordId: contact,
        attributeId: city,
        value: text('Munich'),
        provenance: MANUAL,
      }),
    ])

    const rows = await facts(city)
    expect(rows).toHaveLength(2)
    expect(rows.filter((row) => row.superseded_by_id === null)).toHaveLength(1)
    expect(await values(city)).toHaveLength(1)
  })
})
