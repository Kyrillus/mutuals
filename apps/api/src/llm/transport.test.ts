/**
 * ADR-072's layer 3: contract tests over the **real** transport, with msw standing in for the
 * provider. No key, no network, no money.
 *
 * Two assertions here exist because the natural implementation gets them wrong.
 *
 * `usage: { include: true }` must **not** be sent. OpenRouter documents it as a deprecated no-op —
 * full usage comes back regardless — and the instinct is to send it "to be safe", which is a claim
 * about the provider that then nobody re-checks.
 *
 * And the total deadline must **terminate**, not retry. "A timeout raises `LlmTransportError`"
 * passes perfectly well while the loop silently retries three times underneath it, which is how a
 * 60-second timeout became a three-minute request (ADR-065). So the test counts the requests.
 */
import { HttpResponse, http, passthrough } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { LlmTransportError } from './errors.ts'
import { OpenAiCompatibleProvider, chatRequestBody, readUsage } from './transport.ts'
import type { ChatRequest } from './types.ts'

const BASE_URL = 'https://provider.test/api/v1'
const ENDPOINT = `${BASE_URL}/chat/completions`

const server = setupServer()

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' })
})
afterEach(() => {
  server.resetHandlers()
})
afterAll(() => {
  server.close()
})

const REQUEST: ChatRequest = {
  model: 'test/model',
  messages: [{ role: 'user', content: 'hello' }],
  schemaName: 'probe_v1',
  schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  temperature: 0.1,
}

function provider(
  overrides: Partial<ConstructorParameters<typeof OpenAiCompatibleProvider>[0]> = {},
) {
  return new OpenAiCompatibleProvider({
    baseUrl: BASE_URL,
    apiKey: 'test-key',
    totalTimeoutMs: 5_000,
    attemptTimeoutMs: 2_000,
    // Backoff without the wait: the point of the test is the number of attempts, not the delay.
    sleep: () => Promise.resolve(),
    random: () => 0,
    ...overrides,
  })
}

function okBody(content: string, usage: Record<string, unknown> = { cost: 0.0004 }) {
  return {
    id: 'gen-1',
    model: 'test/model-served',
    provider: 'Upstream',
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 100, completion_tokens: 20, ...usage },
  }
}

describe('the request body', () => {
  it('asks for a strict json_schema and restricts routing to endpoints that honour it', () => {
    const body = chatRequestBody(REQUEST) as Record<string, never>
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'probe_v1', strict: true, schema: REQUEST.schema },
    })
    expect(body.provider).toEqual({ require_parameters: true })
  })

  it('does not send `usage.include` or `stream_options`, both deprecated no-ops (ADR-070)', () => {
    const body = chatRequestBody(REQUEST)
    expect(body.usage).toBeUndefined()
    expect(body.stream_options).toBeUndefined()
    expect(body.stream).toBeUndefined()
  })

  it('omits max_tokens and temperature entirely when the prompt names neither', () => {
    const { temperature: _t, ...bare } = REQUEST
    const body = chatRequestBody(bare)
    expect('temperature' in body).toBe(false)
    expect('max_tokens' in body).toBe(false)
  })
})

describe('a successful call', () => {
  it('returns the content verbatim and reads the usage the provider reported', async () => {
    let sent: unknown
    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        sent = await request.json()
        expect(request.headers.get('authorization')).toBe('Bearer test-key')
        return HttpResponse.json(okBody('{"a":1}'))
      }),
    )

    const response = await provider().complete(REQUEST)
    expect(response.content).toBe('{"a":1}')
    expect(response.usage.costUsd).toBe(0.0004)
    expect(response.usage.costSource).toBe('reported')
    expect(response.usage.promptTokens).toBe(100)
    expect(response.modelServed).toBe('test/model-served')
    expect(response.upstreamProvider).toBe('Upstream')
    expect(response.generationId).toBe('gen-1')
    expect((sent as { model: string }).model).toBe('test/model')
  })

  it('records a cost the provider did not report as unreported, never as an estimate', async () => {
    server.use(http.post(ENDPOINT, () => HttpResponse.json(okBody('{}', {}))))
    const response = await provider().complete(REQUEST)
    expect(response.usage.costUsd).toBeNull()
    expect(response.usage.costSource).toBe('unreported')
  })

  it('tells a reported zero apart from nothing reported', () => {
    expect(readUsage({ usage: { cost: 0 } }).costSource).toBe('free')
    expect(readUsage({ usage: {} }).costSource).toBe('unreported')
  })
})

describe('retries', () => {
  it('retries a 429 and succeeds', async () => {
    let calls = 0
    server.use(
      http.post(ENDPOINT, () => {
        calls += 1
        return calls === 1
          ? new HttpResponse(null, { status: 429, headers: { 'retry-after': '0' } })
          : HttpResponse.json(okBody('{"ok":true}'))
      }),
    )

    const response = await provider().complete(REQUEST)
    expect(response.content).toBe('{"ok":true}')
    expect(calls).toBe(2)
  })

  /** 409 has no meaning for a chat-completions API, so retrying it burns money for nothing. */
  it('does not retry a 409', async () => {
    let calls = 0
    server.use(
      http.post(ENDPOINT, () => {
        calls += 1
        return HttpResponse.json({ error: { message: 'nope' } }, { status: 409 })
      }),
    )

    await expect(provider().complete(REQUEST)).rejects.toBeInstanceOf(LlmTransportError)
    expect(calls).toBe(1)
  })

  it('gives up after three attempts and carries the provider message', async () => {
    let calls = 0
    server.use(
      http.post(ENDPOINT, () => {
        calls += 1
        return HttpResponse.json({ error: { message: 'upstream on fire' } }, { status: 503 })
      }),
    )

    await expect(provider().complete(REQUEST)).rejects.toThrow(/upstream on fire/)
    expect(calls).toBe(3)
  })

  it('checks the budget immediately before every billable POST, retries included', async () => {
    let calls = 0
    let checks = 0
    server.use(
      http.post(ENDPOINT, () => {
        calls += 1
        return calls < 3
          ? new HttpResponse(null, { status: 500 })
          : HttpResponse.json(okBody('{"ok":true}'))
      }),
    )

    await provider({ beforeRequest: () => void (checks += 1) }).complete(REQUEST)
    expect(calls).toBe(3)
    // Three POSTs, three checks. One check per *task* is what let a retry storm bill six
    // generations against a cap of one (ADR-070).
    expect(checks).toBe(3)
  })

  it('stops immediately when the budget check throws, before any request is sent', async () => {
    server.use(http.post(ENDPOINT, () => HttpResponse.json(okBody('{}'))))
    const boom = new Error('budget')
    await expect(
      provider({
        beforeRequest: () => {
          throw boom
        },
      }).complete(REQUEST),
    ).rejects.toBe(boom)
  })
})

describe('the deadlines', () => {
  /**
   * The correction ADR-065 records, asserted by counting.
   *
   * A per-attempt signal composed inside the loop, with a rethrow guarded on `LlmHttpError` or the
   * caller's abort, satisfies neither branch on a timeout — so the loop retries. With
   * `LLM_TIMEOUT_MS=60000` that is over three minutes for one "Ask the network".
   */
  it('terminates on the total deadline rather than retrying into three times the wait', async () => {
    let calls = 0
    server.use(
      http.post(ENDPOINT, async () => {
        calls += 1
        await new Promise((resolve) => setTimeout(resolve, 200))
        return HttpResponse.json(okBody('{}'))
      }),
    )

    const started = Date.now()
    await expect(
      provider({ totalTimeoutMs: 60, attemptTimeoutMs: 60 }).complete(REQUEST),
    ).rejects.toThrow(/did not answer within/)

    expect(calls).toBe(1)
    // The whole call, not three of them: one attempt's wait plus change.
    expect(Date.now() - started).toBeLessThan(180)
  })

  it('retries an attempt that stalled while the overall deadline still has room', async () => {
    let calls = 0
    server.use(
      http.post(ENDPOINT, async () => {
        calls += 1
        if (calls === 1) await new Promise((resolve) => setTimeout(resolve, 300))
        return HttpResponse.json(okBody('{"ok":true}'))
      }),
    )

    const response = await provider({ totalTimeoutMs: 5_000, attemptTimeoutMs: 60 }).complete(
      REQUEST,
    )
    expect(response.content).toBe('{"ok":true}')
    expect(calls).toBe(2)
  })

  it("reports a caller's abort as a cancellation, not as a provider timeout", async () => {
    server.use(
      http.post(ENDPOINT, async () => {
        await new Promise((resolve) => setTimeout(resolve, 500))
        return HttpResponse.json(okBody('{}'))
      }),
    )

    const controller = new AbortController()
    const pending = provider().complete(REQUEST, controller.signal)
    setTimeout(() => controller.abort(), 20)
    await expect(pending).rejects.toThrow(/cancelled/)
  })
})

describe('a provider that answers 200 with nonsense', () => {
  it('refuses a body that is not JSON', async () => {
    server.use(http.post(ENDPOINT, () => HttpResponse.text('<html>gateway</html>')))
    await expect(provider().complete(REQUEST)).rejects.toThrow(/not JSON/)
  })

  it('refuses a body with no message content', async () => {
    server.use(http.post(ENDPOINT, () => HttpResponse.json({ choices: [] })))
    await expect(provider().complete(REQUEST)).rejects.toThrow(/no message content/)
  })

  it('leaves an unrelated host alone, so an unhandled request is a test bug', () => {
    server.use(http.get('https://example.test/', () => passthrough()))
    expect(server.listHandlers().length).toBeGreaterThan(0)
  })
})
