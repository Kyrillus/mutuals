/**
 * The parts of the LLM module that only mean something against a real database: the cost cap, the
 * model override, and turning a name into a record.
 *
 * The cap is the one worth the round trips. "A bug that loops spends someone's real money" is the
 * sentence ADR-070 is written against, and a circuit breaker that has never been observed tripping
 * is a comment.
 */
import { findRecordsByLabel } from '@mutuals/db'
import { testDb } from '@mutuals/db/test-support'
import { makeFieldResolver, type AttributeDefinition } from '@mutuals/core'
import { listAttributeDefinitions } from '@mutuals/db'
import { beforeEach, describe, expect, it } from 'vitest'

import { api, resetLlm, testEnv, testLlm, TEST_NOW } from '../test-support/app.ts'
import { aContact, anOrganization } from '../test-support/fixtures.ts'
import { CostBudget } from './budget.ts'
import { LlmBudgetError } from './errors.ts'
import { envModelFor, modelFor, setModelFor } from './settings.ts'
import { resolveRelationNames } from './tasks/ask.ts'
import { answers } from './test-support.ts'

const WINDOW = { today: '2026-06-15', timeZone: 'Europe/Berlin', now: TEST_NOW, limitUsd: 5 }

async function spend(costUsd: number | null, createdAt: Date = TEST_NOW): Promise<void> {
  await testDb()
    .insertInto('llm_call')
    .values({
      task_kind: 'question',
      prompt_id: 'ask.filter',
      prompt_version: 1,
      prompt_hash: 'hash',
      input_hash: `input-${String(Math.random())}`,
      provider: 'test',
      base_url: 'https://test.invalid',
      model_requested: 'test/model',
      status: 'ok',
      cost_usd: costUsd === null ? null : String(costUsd),
      cost_source: costUsd === null ? 'unreported' : 'reported',
      created_at: createdAt,
    })
    .execute()
}

beforeEach(() => {
  resetLlm()
})

describe('the daily cost cap', () => {
  it('lets a call through while the day is under the limit', async () => {
    await spend(1.5)
    await new CostBudget().assertWithinBudget(testDb(), WINDOW)
  })

  it('refuses once the day has reached the limit, naming both numbers', async () => {
    await spend(3)
    await spend(2.5)

    const budget = new CostBudget()
    await expect(budget.assertWithinBudget(testDb(), WINDOW)).rejects.toBeInstanceOf(LlmBudgetError)
    await budget
      .assertWithinBudget(testDb(), { ...WINDOW, limitUsd: 5 })
      .catch((error: unknown) => {
        expect((error as LlmBudgetError).spentUsd).toBeCloseTo(5.5, 6)
        expect((error as Error).message).toContain('$5.00')
        expect((error as Error).message).toContain('$5.50')
      })
  })

  /** A limit of 0 disables the breaker. `.env.example` documents it and does not recommend it. */
  it('is switched off by a limit of zero', async () => {
    await spend(99)
    await new CostBudget().assertWithinBudget(testDb(), { ...WINDOW, limitUsd: 0 })
  })

  /**
   * The window is the profile's civil day (ADR-045), and the boundary is derived in SQL from the
   * injected instant — so a call from yesterday evening does not count against today.
   */
  it('counts today only, in the profile’s timezone', async () => {
    await spend(9, new Date('2026-06-14T21:00:00.000Z'))
    await new CostBudget().assertWithinBudget(testDb(), WINDOW)

    // 22:30 UTC on the 14th is 00:30 on the 15th in Berlin, so it *is* today's spending.
    await spend(9, new Date('2026-06-14T22:30:00.000Z'))
    await expect(new CostBudget().assertWithinBudget(testDb(), WINDOW)).rejects.toBeInstanceOf(
      LlmBudgetError,
    )
  })

  it('ignores a call whose provider reported no cost, rather than counting it as zero or as one', async () => {
    await spend(null)
    await spend(4.9)
    await new CostBudget().assertWithinBudget(testDb(), WINDOW)
  })

  /**
   * The counter is process-local between refreshes, so spending inside one request is visible to
   * the next check without another query — which is what makes checking per POST affordable.
   */
  it('adds what a call cost without waiting for the next refresh', async () => {
    const budget = new CostBudget()
    await budget.assertWithinBudget(testDb(), WINDOW)
    budget.record(6)
    await expect(budget.assertWithinBudget(testDb(), WINDOW)).rejects.toBeInstanceOf(LlmBudgetError)
  })

  it('answers 429 through the route once the cap is reached', async () => {
    await spend(5.01)
    testLlm().provider.script(
      answers({
        understood: true,
        objectType: 'contact',
        subject: 'x',
        declineReason: null,
        filters: [],
      }),
    )

    const { status, body } = await api.post<{ type: string; detail: string }>('/api/v1/ask', {
      question: 'Who do I know?',
    })

    expect(status).toBe(429)
    expect(body.type).toContain('llm_budget_exceeded')
    expect(body.detail).toContain('$5.00')
    // The gate ran *before* the request, so nothing was sent and nothing was billed.
    expect(testLlm().provider.requests).toHaveLength(0)
  })

  it('writes the refusal into the trace, so a cap that tripped can be explained afterwards', async () => {
    await spend(5.01)
    await api.post('/api/v1/ask', { question: 'Who do I know?' })

    const rows = await testDb()
      .selectFrom('llm_call')
      .select(['status'])
      .where('status', '=', 'budget_exceeded')
      .execute()
    expect(rows).toHaveLength(1)
  })
})

describe('modelFor', () => {
  it('falls back to the environment when no row exists', async () => {
    expect(await modelFor(testDb(), testEnv(), 'question')).toBe(envModelFor(testEnv(), 'question'))
  })

  /** §3.1: swappable without a deploy. A row update, not an env change plus a restart. */
  it('prefers the llm_setting row, which is what "without a deploy" means', async () => {
    await setModelFor(testDb(), 'question', 'another/model')
    expect(await modelFor(testDb(), testEnv(), 'question')).toBe('another/model')

    await setModelFor(testDb(), 'question', 'a/third-model')
    expect(await modelFor(testDb(), testEnv(), 'question')).toBe('a/third-model')
  })

  it('keeps the four task kinds apart', async () => {
    await setModelFor(testDb(), 'summary', 'summary/model')
    expect(await modelFor(testDb(), testEnv(), 'summary')).toBe('summary/model')
    expect(await modelFor(testDb(), testEnv(), 'question')).toBe(envModelFor(testEnv(), 'question'))
  })

  it('is the model the trace records', async () => {
    await setModelFor(testDb(), 'question', 'traced/model')
    testLlm().provider.script(
      answers({
        understood: true,
        objectType: 'contact',
        subject: 'x',
        declineReason: null,
        filters: [],
      }),
    )
    await api.post('/api/v1/ask', { question: 'Who do I know?' })

    const row = await testDb().selectFrom('llm_call').select(['model_requested']).executeTakeFirst()
    expect(row?.model_requested).toBe('traced/model')
  })
})

describe('turning a name into a record', () => {
  async function contactResolver(): Promise<ReturnType<typeof makeFieldResolver>> {
    const definitions: readonly AttributeDefinition[] = await listAttributeDefinitions(
      testDb(),
      'contact',
    )
    return makeFieldResolver('contact', definitions)
  }

  /**
   * `mutuals_norm` is `lower(unaccent(btrim(…)))` and nothing else (ADR-019). Case, accents and
   * surrounding whitespace fold; an internal run of spaces does **not** collapse. Asserted here
   * rather than assumed, because "normalised" invites the assumption that it does.
   */
  it('matches on the normalised label: case, accents and surrounding space fold', async () => {
    const org = await anOrganization({ name: 'Åsa Öberg Kapital' })
    const found = await findRecordsByLabel(testDb(), 'organization', ['  asa oberg KAPITAL '])
    expect(found.get('asa oberg KAPITAL')).toEqual([org.id])
  })

  it('does not collapse an internal run of spaces, because mutuals_norm does not', async () => {
    await anOrganization({ name: 'Northstar Ventures' })
    const found = await findRecordsByLabel(testDb(), 'organization', ['Northstar   Ventures'])
    expect(found.size).toBe(0)
  })

  it('returns every record sharing a label rather than picking one', async () => {
    const first = await anOrganization({ name: 'Kiln Robotics' })
    const second = await anOrganization({ name: 'Kiln Robotics' })
    const found = await findRecordsByLabel(testDb(), 'organization', ['Kiln Robotics'])
    expect(found.get('Kiln Robotics')?.slice().sort()).toEqual([first.id, second.id].sort())
  })

  it('does not cross object types', async () => {
    await aContact({ firstName: 'Northstar', lastName: 'Ventures' })
    expect((await findRecordsByLabel(testDb(), 'organization', ['Northstar Ventures'])).size).toBe(
      0,
    )
  })

  it('resolves only the names a relation filter actually mentions', async () => {
    const org = await anOrganization({ name: 'Northstar Ventures' })
    const resolver = await contactResolver()

    const resolved = await resolveRelationNames(testDb(), resolver, [
      {
        field: 'organization',
        op: 'has_any_of',
        value: null,
        values: ['Northstar Ventures'],
        from: null,
        to: null,
        preset: null,
        n: null,
        unit: null,
      },
      {
        field: 'city',
        op: 'equals',
        value: 'Munich',
        values: null,
        from: null,
        to: null,
        preset: null,
        n: null,
        unit: null,
      },
    ])

    expect([...resolved.keys()]).toEqual(['Northstar Ventures'])
    expect(resolved.get('Northstar Ventures')).toEqual([org.id])
  })

  it('does nothing when no filter names a relation', async () => {
    const resolver = await contactResolver()
    const resolved = await resolveRelationNames(testDb(), resolver, [
      {
        field: 'city',
        op: 'equals',
        value: 'Munich',
        values: null,
        from: null,
        to: null,
        preset: null,
        n: null,
        unit: null,
      },
    ])
    expect(resolved.size).toBe(0)
  })
})

describe('GET /stats/llm', () => {
  it('reports the cap, what has been spent, and the breakdown per prompt version', async () => {
    await spend(0.25)
    await spend(0.75)
    await spend(null)

    const { status, body } = await api.get<{
      limitUsd: number
      spentTodayUsd: number
      enabled: boolean
      rows: { promptId: string; calls: number; costUsd: number; unreportedCalls: number }[]
    }>('/api/v1/stats/llm')

    expect(status).toBe(200)
    expect(body.limitUsd).toBe(5)
    expect(body.spentTodayUsd).toBeCloseTo(1, 6)
    expect(body.enabled).toBe(true)
    expect(body.rows).toHaveLength(1)
    expect(body.rows[0]?.promptId).toBe('ask.filter')
    expect(body.rows[0]?.calls).toBe(3)
    expect(body.rows[0]?.costUsd).toBeCloseTo(1, 6)
    // Without this, a $0.00 total is ambiguous — free, or nothing reported? (ADR-070)
    expect(body.rows[0]?.unreportedCalls).toBe(1)
  })

  it('reports zero on a database where nothing has been asked', async () => {
    const { body } = await api.get<{ spentTodayUsd: number; rows: unknown[] }>('/api/v1/stats/llm')
    expect(body.spentTodayUsd).toBe(0)
    expect(body.rows).toEqual([])
  })
})
