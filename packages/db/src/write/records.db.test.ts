/**
 * Creating, editing and deleting the three record subtypes.
 *
 * Two invariants carry most of this file. `record.display_label` has exactly one owner —
 * `sync_record_label()` — so every test here reads it back rather than writing it. And `record` is
 * the supertype, which is the only reason `ON DELETE CASCADE` reaches five polymorphic tables; the
 * delete test is what proves that claim rather than repeating it.
 */
import { describe, expect, it } from 'vitest'
import { sql } from 'kysely'
import type { Uuid } from '@mutuals/core'
import { attributeIdBySlug, testDb, TEST_WORKSPACE_ID } from '../test-support/index.ts'
import {
  createContact,
  createInteraction,
  createOrganization,
  deleteRecord,
  renameOrganization,
  requireObjectType,
  updateContact,
  updateInteraction,
} from './records.ts'
import { addElement, setValue } from './facts.ts'
import { WriteError } from './types.ts'

async function record(id: Uuid) {
  return testDb()
    .selectFrom('record')
    .select([
      'object_type',
      'display_label',
      'label_norm',
      'created_via',
      'import_batch_id',
      'workspace_id',
      'updated_at',
    ])
    .where('id', '=', id)
    .executeTakeFirstOrThrow()
}

describe('createContact', () => {
  it('writes the supertype, the subtype and the metrics row', async () => {
    const id = await createContact(testDb(), { firstName: 'Anna', lastName: 'Berger' })

    expect(await record(id)).toMatchObject({
      object_type: 'contact',
      display_label: 'Anna Berger',
      label_norm: 'anna berger',
      created_via: 'manual',
      import_batch_id: null,
      workspace_id: TEST_WORKSPACE_ID,
    })

    // The metrics row exists from the first moment, so `warmth` is 0 rather than NULL and the
    // list query's sort on a derived column needs no coalesce.
    const metrics = await testDb()
      .selectFrom('contact_metrics')
      .select(['warmth', 'interaction_count_12m', 'open_followups'])
      .where('contact_id', '=', id)
      .executeTakeFirstOrThrow()
    expect(metrics).toEqual({ warmth: 0, interaction_count_12m: 0, open_followups: 0 })
  })

  it('derives the label from whichever name is there', async () => {
    const first = await createContact(testDb(), { firstName: 'Anna' })
    const last = await createContact(testDb(), { lastName: 'Berger' })
    const neither = await createContact(testDb(), {})

    expect((await record(first)).display_label).toBe('Anna')
    expect((await record(last)).display_label).toBe('Berger')
    expect((await record(neither)).display_label).toBe('')
  })

  it('carries its provenance', async () => {
    const batch = await testDb()
      .insertInto('import_batch')
      .values({
        workspace_id: TEST_WORKSPACE_ID,
        file_name: 'linkedin.csv',
        object_type: 'contact',
      })
      .returning('id')
      .executeTakeFirstOrThrow()

    const id = await createContact(testDb(), {
      firstName: 'Anna',
      createdVia: 'import',
      importBatchId: batch.id,
    })

    expect(await record(id)).toMatchObject({ created_via: 'import', import_batch_id: batch.id })
  })

  it('writes its attribute values in the same transaction', async () => {
    const city = await attributeIdBySlug('contact', 'city')
    const tags = await attributeIdBySlug('contact', 'areas_of_interest')

    const id = await createContact(testDb(), {
      firstName: 'Anna',
      lastName: 'Berger',
      values: [
        { attributeId: city, values: [{ kind: 'text', text: 'Berlin' }] },
        {
          attributeId: tags,
          values: [
            { kind: 'text', text: 'Climate' },
            { kind: 'text', text: 'Biotech' },
          ],
        },
      ],
      provenance: { source: 'import', sourceRef: 'row-7' },
    })

    const rows = await testDb()
      .selectFrom('attribute_value')
      .select(['attribute_id', 'text_value'])
      .where('record_id', '=', id)
      .execute()
    expect(rows).toHaveLength(3)

    const sources = await sql<{ source: string; source_ref: string | null }>`
      select distinct source, source_ref from fact where record_id = ${id}
    `.execute(testDb())
    expect(sources.rows).toEqual([{ source: 'import', source_ref: 'row-7' }])
  })
})

describe('updateContact', () => {
  it('moves the label with the name', async () => {
    const id = await createContact(testDb(), { firstName: 'Anna', lastName: 'Berger' })
    const changed = await updateContact(testDb(), id, { lastName: 'Bergér-Klein' })

    expect(changed).toBe(true)
    expect(await record(id)).toMatchObject({
      display_label: 'Anna Bergér-Klein',
      label_norm: 'anna berger-klein',
    })
  })

  it('reports false for an empty patch', async () => {
    const id = await createContact(testDb(), { firstName: 'Anna' })
    expect(await updateContact(testDb(), id, {})).toBe(false)
  })

  it('sets the warmth overrides, which are columns and not attributes', async () => {
    const id = await createContact(testDb(), { firstName: 'Anna' })
    await updateContact(testDb(), id, { pinnedImportant: true, notImportant: false })

    const row = await testDb()
      .selectFrom('contact')
      .select(['pinned_important', 'not_important'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    expect(row).toEqual({ pinned_important: true, not_important: false })
  })
})

describe('an organization', () => {
  it('takes its label from its name, and keeps it in step', async () => {
    const id = await createOrganization(testDb(), { name: 'Northstar Ventures' })
    expect(await record(id)).toMatchObject({
      object_type: 'organization',
      display_label: 'Northstar Ventures',
      label_norm: 'northstar ventures',
    })

    expect(await renameOrganization(testDb(), id, 'Northstar')).toBe(true)
    expect((await record(id)).display_label).toBe('Northstar')
  })

  it('gets its metrics row on creation', async () => {
    const id = await createOrganization(testDb(), { name: 'Northstar Ventures' })
    const metrics = await testDb()
      .selectFrom('organization_metrics')
      .select('people_count')
      .where('organization_id', '=', id)
      .executeTakeFirstOrThrow()
    expect(metrics.people_count).toBe(0)
  })
})

describe('an interaction', () => {
  it('is a record with participants', async () => {
    const anna = await createContact(testDb(), { firstName: 'Anna', lastName: 'Berger' })
    const org = await createOrganization(testDb(), { name: 'Northstar Ventures' })

    const id = await createInteraction(testDb(), {
      type: 'Meeting',
      occurredAt: '2026-02-01T10:00:00Z',
      title: 'Coffee at Betahaus',
      body: 'Talked about the fund.',
      contactIds: [anna],
      organizationIds: [org],
    })

    expect(await record(id)).toMatchObject({
      object_type: 'interaction',
      display_label: 'Coffee at Betahaus',
    })

    const contacts = await testDb()
      .selectFrom('interaction_contact')
      .select('contact_id')
      .where('interaction_id', '=', id)
      .execute()
    expect(contacts.map((row) => row.contact_id)).toEqual([anna])
  })

  it('replaces its participant list rather than adding to it', async () => {
    const anna = await createContact(testDb(), { firstName: 'Anna' })
    const ben = await createContact(testDb(), { firstName: 'Ben' })
    const id = await createInteraction(testDb(), {
      type: 'Call',
      occurredAt: '2026-02-01T10:00:00Z',
      contactIds: [anna],
    })

    const before = (await record(id)).updated_at
    await updateInteraction(testDb(), id, { contactIds: [ben] })

    const contacts = await testDb()
      .selectFrom('interaction_contact')
      .select('contact_id')
      .where('interaction_id', '=', id)
      .execute()
    expect(contacts.map((row) => row.contact_id)).toEqual([ben])
    expect((await record(id)).updated_at.valueOf()).toBeGreaterThanOrEqual(before.valueOf())
  })

  it('takes its label from its title, and an untitled one has none', async () => {
    const id = await createInteraction(testDb(), {
      type: 'Note',
      occurredAt: '2026-02-01T10:00:00Z',
    })
    expect((await record(id)).display_label).toBe('')

    await updateInteraction(testDb(), id, { title: 'Voicemail' })
    expect((await record(id)).display_label).toBe('Voicemail')
  })

  it('rejects a type outside the closed set', async () => {
    await expect(
      createInteraction(testDb(), {
        type: 'Coffee' as never,
        occurredAt: '2026-02-01T10:00:00Z',
      }),
    ).rejects.toMatchObject({ code: '23514' })
  })
})

describe('deleteRecord', () => {
  it('takes everything derived from the record with it', async () => {
    const anna = await createContact(testDb(), { firstName: 'Anna', lastName: 'Berger' })
    const org = await createOrganization(testDb(), { name: 'Northstar Ventures' })
    const email = await attributeIdBySlug('contact', 'email')
    const relation = await attributeIdBySlug('contact', 'organization')

    await setValue(testDb(), {
      recordId: anna,
      attributeId: email,
      value: { kind: 'text', text: 'anna@example.com' },
      provenance: { source: 'manual' },
    })
    await addElement(testDb(), {
      recordId: anna,
      attributeId: relation,
      value: { kind: 'relation', targetRecordId: org },
      provenance: { source: 'manual' },
    })
    await testDb()
      .insertInto('follow_up')
      .values({
        workspace_id: TEST_WORKSPACE_ID,
        contact_id: anna,
        title: 'Send the deck',
        due_at: '2026-03-01',
      })
      .execute()

    expect(await deleteRecord(testDb(), anna)).toBe(true)

    const counts = await sql<{ table_name: string; rows: string }>`
      select 'fact' as table_name, count(*)::text as rows from fact where record_id = ${anna}
      union all select 'attribute_value', count(*)::text from attribute_value where record_id = ${anna}
      union all select 'record_link', count(*)::text from record_link where from_record_id = ${anna}
      union all select 'identifier', count(*)::text from identifier where record_id = ${anna}
      union all select 'search_document', count(*)::text from search_document where record_id = ${anna}
      union all select 'contact', count(*)::text from contact where id = ${anna}
      union all select 'contact_metrics', count(*)::text from contact_metrics where contact_id = ${anna}
      union all select 'follow_up', count(*)::text from follow_up where contact_id = ${anna}
    `.execute(testDb())

    expect(counts.rows.filter((row) => row.rows !== '0')).toEqual([])
    // The organization is untouched: a link is not ownership.
    expect(await requireObjectType(testDb(), org)).toBe('organization')
  })

  it('reprojects the other side when a link target is deleted', async () => {
    const anna = await createContact(testDb(), { firstName: 'Anna' })
    const org = await createOrganization(testDb(), { name: 'Northstar Ventures' })
    const relation = await attributeIdBySlug('contact', 'organization')

    await addElement(testDb(), {
      recordId: anna,
      attributeId: relation,
      value: { kind: 'relation', targetRecordId: org },
      provenance: { source: 'manual' },
    })
    await deleteRecord(testDb(), org)

    // The fact cascades because target_record_id references record; the statement-level backstop
    // on `fact` then reprojects Anna, which is what leaves no dangling record_link behind.
    const links = await testDb()
      .selectFrom('record_link')
      .select('id')
      .where('from_record_id', '=', anna)
      .execute()
    expect(links).toEqual([])
  })

  it('reports false for an id that is not there', async () => {
    expect(await deleteRecord(testDb(), '00000000-0000-4000-8000-0000000000ff')).toBe(false)
  })
})

describe('requireObjectType', () => {
  it('names the subtype an id points at', async () => {
    const id = await createContact(testDb(), { firstName: 'Anna' })
    expect(await requireObjectType(testDb(), id)).toBe('contact')
  })

  it('throws for an id that is not a record', async () => {
    await expect(
      requireObjectType(testDb(), '00000000-0000-4000-8000-0000000000ff'),
    ).rejects.toBeInstanceOf(WriteError)
  })
})

describe('search_document', () => {
  it('collects the label, the text values and the option labels of a record', async () => {
    const jobRole = await attributeIdBySlug('contact', 'job_role')
    const founder = await testDb()
      .selectFrom('attribute_option')
      .select('id')
      .where('attribute_id', '=', jobRole)
      .where('key', '=', 'founder')
      .executeTakeFirstOrThrow()
    const city = await attributeIdBySlug('contact', 'city')

    const anna = await createContact(testDb(), {
      firstName: 'Anna',
      lastName: 'Berger',
      values: [
        { attributeId: city, values: [{ kind: 'text', text: 'Berlin' }] },
        {
          attributeId: jobRole,
          values: [{ kind: 'option', optionId: founder.id, optionKey: 'founder' }],
        },
      ],
      provenance: { source: 'manual' },
    })

    const document = await testDb()
      .selectFrom('search_document')
      .select(['title', 'body'])
      .where('record_id', '=', anna)
      .executeTakeFirstOrThrow()

    expect(document.title).toBe('Anna Berger')
    expect(document.body).toContain('Berlin')
    expect(document.body).toContain('Founder')
  })

  /**
   * Both of these were red before `write/records.ts` learned to call the projector. The projection
   * is normally kept current by the `AFTER STATEMENT` trigger on `fact`, and a record whose name
   * lives in a column rather than in a fact never fires it — so a contact with no attribute values
   * was simply absent from search, and a rename left the old name in the index. Found by the
   * projection-equivalence gate of ADR-025, which is exactly the failure it exists to produce.
   */
  it('exists for a record that has no attribute values at all', async () => {
    const interaction = await createInteraction(testDb(), {
      type: 'Note',
      occurredAt: '2026-02-01T10:00:00Z',
      title: 'Voicemail',
      body: 'Call back about the fund.',
    })
    const anna = await createContact(testDb(), { firstName: 'Anna', lastName: 'Berger' })

    const documents = await testDb()
      .selectFrom('search_document')
      .select(['record_id', 'title', 'body'])
      .where('record_id', 'in', [interaction, anna])
      .execute()

    expect(documents).toHaveLength(2)
    expect(documents.find((row) => row.record_id === interaction)?.body).toContain(
      'Call back about the fund.',
    )
  })

  it('follows a rename', async () => {
    const org = await createOrganization(testDb(), { name: 'Northstar Ventures' })
    await renameOrganization(testDb(), org, 'Northstar')

    const document = await testDb()
      .selectFrom('search_document')
      .select(['title', 'body'])
      .where('record_id', '=', org)
      .executeTakeFirstOrThrow()

    expect(document.title).toBe('Northstar')
    expect(document.body).not.toContain('Ventures')
  })

  it('follows an edited interaction body', async () => {
    const interaction = await createInteraction(testDb(), {
      type: 'Note',
      occurredAt: '2026-02-01T10:00:00Z',
      title: 'Voicemail',
      body: 'Call back.',
    })
    await updateInteraction(testDb(), interaction, { body: 'Call back about the term sheet.' })

    const document = await testDb()
      .selectFrom('search_document')
      .select('body')
      .where('record_id', '=', interaction)
      .executeTakeFirstOrThrow()

    expect(document.body).toContain('term sheet')
  })
})
