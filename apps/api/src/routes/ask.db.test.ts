/**
 * §4.8's "ask the network", end to end against a real database and a scripted model.
 *
 * The property worth testing is not "the LLM answered". It is that **what the model says becomes a
 * filter the ordinary list endpoint runs**, that a filter the model gets wrong never reaches the
 * compiler, and that every exchange leaves a row in `llm_call` — the trace ADR-068 exists for.
 *
 * The model is a `ScriptedProvider` (ADR-072's layer 2). Live calls are not in CI, and the
 * interesting cases here — a slug that does not exist, a repair that fixes it, a budget refusal —
 * cannot be produced reliably against a live model anyway.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { AskResponse, Problem } from '@mutuals/core'

import { api, resetLlm, testLlm } from '../test-support/app.ts'
import { aContact, anOrganization } from '../test-support/fixtures.ts'
import { answers, answersRaw, failsWith } from '../llm/test-support.ts'
import { LlmTransportError } from '../llm/errors.ts'
import { testDb } from '@mutuals/db/test-support'

interface ScriptedFilter {
  field: string
  op: string
  value?: string | null
  values?: string[] | null
  from?: string | null
  to?: string | null
  preset?: string | null
  n?: number | null
  unit?: string | null
}

/** The model's answer, in the flat shape the prompt's output schema declares. */
function modelAnswer(overrides: {
  filters?: ScriptedFilter[]
  objectType?: string
  subject?: string
  understood?: boolean
  declineReason?: string | null
}) {
  return {
    understood: overrides.understood ?? true,
    objectType: overrides.objectType ?? 'contact',
    subject: overrides.subject ?? 'contacts in Munich',
    declineReason: overrides.declineReason ?? null,
    filters: (overrides.filters ?? []).map((filter) => ({
      value: null,
      values: null,
      from: null,
      to: null,
      preset: null,
      n: null,
      unit: null,
      ...filter,
    })),
  }
}

async function llmCalls(): Promise<
  { prompt_id: string; status: string; attempt: number; repair_of_id: string | null }[]
> {
  return testDb()
    .selectFrom('llm_call')
    .select(['prompt_id', 'status', 'attempt', 'repair_of_id'])
    .orderBy('created_at')
    .execute()
}

beforeEach(() => {
  resetLlm()
})

describe('POST /ask', () => {
  it('turns a question into a filter, runs it, and ships the filter it ran', async () => {
    await aContact({ firstName: 'Anna', lastName: 'Berger', attributes: { city: 'Munich' } })
    await aContact({ firstName: 'Ben', lastName: 'Roth', attributes: { city: 'Berlin' } })

    testLlm().provider.script(
      answers(modelAnswer({ filters: [{ field: 'city', op: 'equals', value: 'Munich' }] })),
    )

    const { status, body } = await api.post<AskResponse>('/api/v1/ask', {
      question: 'Who do I know in Munich?',
    })

    expect(status).toBe(200)
    expect(body.objectType).toBe('contact')
    // §4.8: the answer shows *which filter it ran*, in the ordinary filter model — so the user can
    // trust it, correct it, or open it as a table.
    expect(body.filter).toEqual([{ field: 'city', op: 'equals', value: 'Munich' }])
    expect(body.matches.map((match) => match.displayName)).toEqual(['Anna Berger'])
    expect(body.total).toBe(1)
    expect(body.answer).toBe('Found 1 contact matching contacts in Munich.')
  })

  it('counts every match while shipping only a page of chips', async () => {
    for (let i = 0; i < 30; i += 1) {
      await aContact({ firstName: `Person${String(i)}`, lastName: 'Munich' })
    }
    testLlm().provider.script(answers(modelAnswer({ filters: [], subject: 'everyone' })))

    const { body } = await api.post<AskResponse>('/api/v1/ask', { question: 'Who do I know?' })
    // The count is the real one; the chips are capped. "5 of 340" reads very differently from "5",
    // and the model is never asked for either number (ADR-103).
    expect(body.total).toBe(30)
    expect(body.matches).toHaveLength(25)
    expect(body.answer).toBe('Found 30 contacts matching everyone.')
  })

  it('answers about organizations when the model picks that table', async () => {
    await anOrganization({ name: 'Northstar Ventures', attributes: { city: 'Berlin' } })
    await aContact({ firstName: 'Anna', lastName: 'Berger' })

    testLlm().provider.script(
      answers(
        modelAnswer({
          objectType: 'organization',
          subject: 'organizations in Berlin',
          filters: [{ field: 'city', op: 'equals', value: 'Berlin' }],
        }),
      ),
    )

    const { body } = await api.post<AskResponse>('/api/v1/ask', {
      question: 'Which companies are in Berlin?',
    })
    expect(body.objectType).toBe('organization')
    expect(body.matches.map((match) => match.displayName)).toEqual(['Northstar Ventures'])
  })

  it('is given both tables to choose from, and only one when the caller pins it', async () => {
    testLlm().provider.script(answers(modelAnswer({ filters: [] })))
    await api.post('/api/v1/ask', { question: 'anything' })
    const both = testLlm().provider.requests[0]?.messages[1]?.content ?? ''
    expect(both).toContain('contact fields')
    expect(both).toContain('organization fields')

    resetLlm()
    testLlm().provider.script(answers(modelAnswer({ filters: [] })))
    await api.post('/api/v1/ask', { question: 'anything', objectType: 'contact' })
    const pinned = testLlm().provider.requests[0]?.messages[1]?.content ?? ''
    expect(pinned).toContain('contact fields')
    expect(pinned).not.toContain('organization fields')
  })

  /**
   * The one rule, at the only boundary where a model could break it. `favourite_colour` does not
   * exist; the compiler never sees it, and the second attempt is told exactly what was wrong.
   */
  it('refuses a field that does not exist and repairs it in one more round trip', async () => {
    await aContact({ firstName: 'Anna', lastName: 'Berger', attributes: { city: 'Munich' } })

    testLlm().provider.script(
      answers(
        modelAnswer({ filters: [{ field: 'favourite_colour', op: 'equals', value: 'blue' }] }),
      ),
      answers(modelAnswer({ filters: [{ field: 'city', op: 'equals', value: 'Munich' }] })),
    )

    const { status, body } = await api.post<AskResponse>('/api/v1/ask', {
      question: 'Who do I know in Munich?',
    })

    expect(status).toBe(200)
    expect(body.filter).toEqual([{ field: 'city', op: 'equals', value: 'Munich' }])

    const second = testLlm().provider.requests[1]?.messages[1]?.content ?? ''
    expect(second).toContain('was rejected')
    expect(second).toContain('"favourite_colour" is not a field')
  })

  it('answers plainly when even the repair cannot be expressed, rather than failing', async () => {
    testLlm().provider.script(
      answers(modelAnswer({ filters: [{ field: 'nope', op: 'equals', value: 'x' }] })),
      answers(modelAnswer({ filters: [{ field: 'still_nope', op: 'equals', value: 'x' }] })),
    )

    const { status, body } = await api.post<AskResponse>('/api/v1/ask', {
      question: 'Who has the biggest shoes?',
    })

    expect(status).toBe(200)
    // Nothing ran, and `filter: null` says so — an empty array would mean "everyone" (ADR-102).
    expect(body.filter).toBeNull()
    expect(body.matches).toEqual([])
    expect(body.answer).toContain('could not turn that into a search')
  })

  it('passes a decline through in the model’s own words', async () => {
    testLlm().provider.script(
      answers(
        modelAnswer({
          understood: false,
          declineReason: 'I have no field for the weather.',
          filters: [],
        }),
      ),
    )

    const { body } = await api.post<AskResponse>('/api/v1/ask', { question: 'Is it raining?' })
    expect(body.filter).toBeNull()
    expect(body.answer).toBe('I have no field for the weather.')
    expect(testLlm().provider.requests).toHaveLength(1)
  })

  /** The relation half: the model gives a name, the database decides which record it means. */
  it('turns a company name into the record it names', async () => {
    const northstar = await anOrganization({ name: 'Northstar Ventures' })
    await anOrganization({ name: 'Kiln Robotics' })
    await aContact({
      firstName: 'Anna',
      lastName: 'Berger',
      attributes: { organization: [{ id: northstar.id }] },
    })
    await aContact({ firstName: 'Ben', lastName: 'Roth' })

    testLlm().provider.script(
      answers(
        modelAnswer({
          subject: 'people at Northstar Ventures',
          filters: [{ field: 'organization', op: 'has_any_of', values: ['Northstar Ventures'] }],
        }),
      ),
    )

    const { body } = await api.post<AskResponse>('/api/v1/ask', {
      question: 'Who works at Northstar Ventures?',
    })
    expect(body.filter).toEqual([
      { field: 'organization', op: 'has_any_of', values: [northstar.id] },
    ])
    expect(body.matches.map((match) => match.displayName)).toEqual(['Anna Berger'])
  })

  it('says so when the company it names is not a record', async () => {
    testLlm().provider.script(
      answers(
        modelAnswer({
          filters: [{ field: 'organization', op: 'has_any_of', values: ['Nowhere GmbH'] }],
        }),
      ),
      answers(
        modelAnswer({
          filters: [{ field: 'organization', op: 'has_any_of', values: ['Nowhere GmbH'] }],
        }),
      ),
    )

    const { body } = await api.post<AskResponse>('/api/v1/ask', {
      question: 'Who works at Nowhere GmbH?',
    })
    expect(body.filter).toBeNull()
  })
})

describe('the trace', () => {
  it('writes one `llm_call` row per exchange, with the validated output', async () => {
    testLlm().provider.script(
      answers(modelAnswer({ filters: [{ field: 'city', op: 'equals', value: 'Munich' }] })),
    )
    await api.post('/api/v1/ask', { question: 'Who is in Munich?' })

    const rows = await testDb()
      .selectFrom('llm_call')
      .select([
        'prompt_id',
        'prompt_version',
        'task_kind',
        'status',
        'parsed',
        'cost_usd',
        'cost_source',
      ])
      .execute()

    expect(rows).toHaveLength(1)
    expect(rows[0]?.prompt_id).toBe('ask.filter')
    expect(rows[0]?.prompt_version).toBe(1)
    expect(rows[0]?.task_kind).toBe('question')
    expect(rows[0]?.status).toBe('ok')
    expect(rows[0]?.cost_source).toBe('reported')
    // `numeric` comes back as a string from node-pg, which is the only way a small cost survives.
    expect(Number(rows[0]?.cost_usd)).toBeCloseTo(0.000_12, 8)
    expect((rows[0]?.parsed as { subject?: string } | null)?.subject).toBe('contacts in Munich')
  })

  /**
   * The five-part replay key (ADR-068). `prompt_hash` is the prompt *template* hash and is constant
   * per version; `input_hash` is what varies per call. Migration 0006's comment said the opposite,
   * which would make every row its own key and nothing would ever replay.
   */
  it('keeps prompt_hash constant across two different questions and input_hash different', async () => {
    testLlm().provider.script(
      answers(modelAnswer({ filters: [] })),
      answers(modelAnswer({ filters: [] })),
    )
    await api.post('/api/v1/ask', { question: 'Who is in Munich?' })
    await api.post('/api/v1/ask', { question: 'Who is in Berlin?' })

    const rows = await testDb()
      .selectFrom('llm_call')
      .select(['prompt_hash', 'input_hash'])
      .orderBy('created_at')
      .execute()

    expect(rows).toHaveLength(2)
    expect(rows[0]?.prompt_hash).toBe(rows[1]?.prompt_hash)
    expect(rows[0]?.input_hash).not.toBe(rows[1]?.input_hash)
  })

  it('links a schema repair to what it repaired', async () => {
    testLlm().provider.script(
      answersRaw('{"understood": true}'),
      answers(modelAnswer({ filters: [] })),
    )
    await api.post('/api/v1/ask', { question: 'Who do I know?' })

    const rows = await llmCalls()
    expect(rows).toHaveLength(2)
    expect(rows[0]?.status).toBe('schema_error')
    expect(rows[0]?.attempt).toBe(1)
    expect(rows[1]?.status).toBe('ok')
    expect(rows[1]?.attempt).toBe(2)
    // Two rows, linked — which is what makes "how often does the repair fire" answerable.
    expect(rows[1]?.repair_of_id).toBeTruthy()
  })

  it('records a body that is not JSON at all as invalid_json, not as a schema error', async () => {
    testLlm().provider.script(answersRaw('I am afraid I cannot do that'), answersRaw('nor that'))
    const { status, body } = await api.post<Problem>('/api/v1/ask', { question: 'Who do I know?' })

    expect(status).toBe(502)
    expect(body.type).toContain('llm_invalid_response')
    const rows = await llmCalls()
    expect(rows.map((row) => row.status)).toEqual(['invalid_json', 'invalid_json'])
  })

  it('records a transport failure too, so a timeout is not invisible', async () => {
    testLlm().provider.script(
      failsWith(new LlmTransportError('nothing answered', { callStatus: 'timeout' })),
    )
    const { status, body } = await api.post<Problem>('/api/v1/ask', { question: 'Who do I know?' })

    expect(status).toBe(504)
    expect(body.type).toContain('llm_unavailable')
    expect(body.detail).toContain('nothing answered')
    expect((await llmCalls()).map((row) => row.status)).toEqual(['timeout'])
  })
})
