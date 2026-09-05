/**
 * ADR-072's layer 4: one **live**, billable call, off by default.
 *
 * It exists because the three layers above it all agree with each other by construction — the
 * golden schema, the fixture provider and the msw contract test share this repository's idea of
 * what a provider does. Only this one can find out that the idea is wrong: that the model id no
 * longer exists, that `provider.require_parameters` is refused, that `usage.cost` stopped being
 * returned, or that `strict: true` is honoured in name only.
 *
 * It never runs in CI. Secrets are unavailable to a pull request from a fork, so a live call there
 * would give an outside contributor a red build they cannot fix.
 *
 *   MUTUALS_LLM_LIVE=1 pnpm vitest run --project unit apps/api/src/llm/live.test.ts
 */
import { describe, expect, it } from 'vitest'

import { loadEnv } from '../env.ts'
import { askFilterPrompt } from './prompts/ask-filter.ts'
import { outputJsonSchema, schemaNameOf } from './prompts/spec.ts'
import { OpenAiCompatibleProvider } from './transport.ts'

const ENABLED = process.env.MUTUALS_LLM_LIVE === '1' && process.env.OPENROUTER_API_KEY !== undefined

describe('a live call', () => {
  it.skipIf(!ENABLED)(
    'answers the ask prompt in the shape the production schema requires',
    async () => {
      const env = loadEnv()
      const provider = new OpenAiCompatibleProvider({
        baseUrl: env.LLM_BASE_URL,
        apiKey: env.OPENROUTER_API_KEY ?? '',
        totalTimeoutMs: env.LLM_TOTAL_TIMEOUT_MS,
        attemptTimeoutMs: env.LLM_ATTEMPT_TIMEOUT_MS,
      })

      const response = await provider.complete({
        model: env.LLM_MODEL_ANSWER,
        messages: askFilterPrompt.render(askFilterPrompt.sample),
        schemaName: schemaNameOf(askFilterPrompt),
        schema: outputJsonSchema(askFilterPrompt),
        temperature: askFilterPrompt.temperature ?? 0.1,
      })

      const parsed = askFilterPrompt.output.safeParse(JSON.parse(response.content))
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)

      // ADR-070's premise, checked against the live provider rather than against a fixture: full
      // usage comes back without asking for it. If this is ever null, the cap is counting nothing.
      expect(response.usage.costUsd).not.toBeNull()
      expect(response.usage.promptTokens).toBeGreaterThan(0)

      // The sample asks about investors in Munich who have not been spoken to in six months.
      const slugs = (parsed.success ? parsed.data.filters : []).map((filter) => filter.field)
      expect(
        slugs.every((slug) => ['city', 'job_role', 'last_interaction_at'].includes(slug)),
      ).toBe(true)
    },
    60_000,
  )

  it.runIf(!ENABLED)('is skipped: set MUTUALS_LLM_LIVE=1 to spend real money', () => {
    expect(ENABLED).toBe(false)
  })
})
