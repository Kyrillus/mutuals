/**
 * The task client's own decisions, with no database and no network: when it refuses to run at all,
 * and what it does with an answer that is the wrong shape.
 *
 * Tracing is exercised against a real database in `llm.db.test.ts`. Here the executor is a stub
 * that throws — which is itself a property worth pinning: **a failure to write the trace must never
 * fail the task.** The row records work that has already been paid for, and losing it is a worse
 * day than nothing, but a much better one than turning a good answer into a 500.
 */
import { describe, expect, it, vi } from 'vitest'

import { parseEnv, type Env } from '../env.ts'
import { LlmClient } from './client.ts'
import { LlmDisabledError, LlmSchemaError } from './errors.ts'
import { askFilterPrompt } from './prompts/ask-filter.ts'
import { ScriptedProvider, answers, answersRaw } from './test-support.ts'
import type { Executor } from '@mutuals/db'

const NOW = new Date('2026-06-15T09:00:00.000Z')

/**
 * A database where the model-override lookup finds nothing and every write fails.
 *
 * The read has to work — `modelFor` consults `llm_setting` before any call — and the write has to
 * fail, because that is the property under test: losing the trace row must not lose the answer.
 */
const chain = {
  select: () => chain,
  where: () => chain,
  executeTakeFirst: () => Promise.resolve(undefined),
}

const traceless = {
  selectFrom: () => chain,
  insertInto: () => {
    throw new Error('no database in a unit test')
  },
} as unknown as Executor

function env(overrides: Record<string, string> = {}): Env {
  return parseEnv({
    DATABASE_URL: 'postgres://mutuals:mutuals@localhost:5432/mutuals_test',
    NODE_ENV: 'test',
    // The cap off, because it is the one thing here that genuinely needs Postgres — it is an
    // indexed aggregate over `llm_call`, and it is tested against a real database in
    // `llm.db.test.ts`, including the 429 the route answers with.
    LLM_DAILY_COST_LIMIT_USD: '0',
    ...overrides,
  })
}

const OUTPUT = {
  understood: true,
  objectType: 'contact',
  subject: 'contacts in Munich',
  declineReason: null,
  filters: [],
}

const OPTIONS = { timeZone: 'Europe/Berlin' }

describe('availability', () => {
  it('is off with no API key, and says what to do about it', () => {
    const client = new LlmClient({ env: env(), now: () => NOW })
    const availability = client.availability()
    expect(availability.enabled).toBe(false)
    expect(availability.reason).toContain('OPENROUTER_API_KEY')
  })

  it('is off when the mode says so, whatever keys exist', () => {
    const client = new LlmClient({
      env: env({ LLM_MODE: 'off', OPENROUTER_API_KEY: 'sk-test' }),
      now: () => NOW,
    })
    expect(client.availability()).toMatchObject({ enabled: false, mode: 'off' })
  })

  it('is on in replay mode with no key at all, which is what the e2e suite runs', () => {
    const client = new LlmClient({ env: env({ LLM_MODE: 'replay' }), now: () => NOW })
    expect(client.availability()).toMatchObject({ enabled: true, mode: 'replay' })
  })

  it('refuses to run a task when it is off, before anything is asked', async () => {
    const provider = new ScriptedProvider([answers(OUTPUT)])
    const client = new LlmClient({ env: env({ LLM_MODE: 'off' }), now: () => NOW, provider })

    await expect(
      client.run(traceless, askFilterPrompt, askFilterPrompt.sample, OPTIONS),
    ).rejects.toBeInstanceOf(LlmDisabledError)
    expect(provider.requests).toHaveLength(0)
  })
})

describe('validation and repair', () => {
  it('returns the validated value, with the trace unavailable', async () => {
    const provider = new ScriptedProvider([answers(OUTPUT)])
    const client = new LlmClient({ env: env(), now: () => NOW, provider })

    const result = await client.run(traceless, askFilterPrompt, askFilterPrompt.sample, OPTIONS)
    expect(result.value.subject).toBe('contacts in Munich')
    expect(result.callId).toBeNull()
    expect(result.repaired).toBe(false)
  })

  it('reports the trace failure to its logger rather than swallowing it silently', async () => {
    const onTraceError = vi.fn()
    const client = new LlmClient({
      env: env(),
      now: () => NOW,
      provider: new ScriptedProvider([answers(OUTPUT)]),
      onTraceError,
    })

    await client.run(traceless, askFilterPrompt, askFilterPrompt.sample, OPTIONS)
    expect(onTraceError).toHaveBeenCalled()
  })

  /** ADR-066: `strict: true` is asked for and never trusted, so the repair path is reachable. */
  it('spends exactly one repair round-trip on a schema failure', async () => {
    const provider = new ScriptedProvider([answersRaw('{"understood": true}'), answers(OUTPUT)])
    const client = new LlmClient({ env: env(), now: () => NOW, provider })

    const result = await client.run(traceless, askFilterPrompt, askFilterPrompt.sample, OPTIONS)
    expect(result.repaired).toBe(true)
    expect(provider.requests).toHaveLength(2)

    // The repair carries the failed answer and the validator's complaint, as two more turns — so it
    // works for every prompt, not only for one whose input type happens to carry a `problems` field.
    const repair = provider.requests[1]?.messages ?? []
    expect(repair.at(-2)?.role).toBe('assistant')
    expect(repair.at(-1)?.content).toContain('did not match the required schema')
    expect(repair.at(-1)?.content).toContain('objectType')
  })

  it('gives up after one repair, and says which fields were wrong', async () => {
    const provider = new ScriptedProvider([answersRaw('{}'), answersRaw('{"still": "wrong"}')])
    const client = new LlmClient({ env: env(), now: () => NOW, provider })

    await expect(
      client.run(traceless, askFilterPrompt, askFilterPrompt.sample, OPTIONS),
    ).rejects.toBeInstanceOf(LlmSchemaError)
    // Two, never three: a repair loop that keeps going is a bill that keeps growing.
    expect(provider.requests).toHaveLength(2)
  })

  it('asks for a strict json_schema named after the prompt and its version', async () => {
    const provider = new ScriptedProvider([answers(OUTPUT)])
    const client = new LlmClient({ env: env(), now: () => NOW, provider })

    await client.run(traceless, askFilterPrompt, askFilterPrompt.sample, OPTIONS)
    expect(provider.requests[0]?.schemaName).toBe('ask_filter_v1')
    expect(provider.requests[0]?.schema).toMatchObject({ additionalProperties: false })
  })
})
