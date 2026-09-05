/**
 * A stand-in for the model provider, for the e2e suite only.
 *
 * The e2e suite drives a **built** API in its own process (ADR-088), so the fixture provider that
 * serves the integration tests cannot be injected into it. This is the equivalent one HTTP hop
 * further out: an OpenAI-compatible `/chat/completions` that answers from a small table keyed on
 * the question. `LLM_BASE_URL` points the built API here.
 *
 * Why not `LLM_MODE=replay`, which ADR-068 built for exactly this? Because the replay key includes
 * the hash of the task input, and the ask prompt's input contains **today's date** (ADR-034 injects
 * it, and §6.1's answer needs it for "in the last 30 days"). A committed fixture would therefore
 * replay only on the day it was recorded and fail loudly every day after — which is the mechanism
 * working correctly and a test that cannot be kept green. Replay stays what it is for: a developer
 * re-running one recorded exchange on demand.
 *
 * This is also a better test than replay would be. Everything downstream of the socket is real —
 * the transport, the retry policy, `usage.cost`, the strict `response_format`, the Zod
 * re-validation, `buildFilterSet`, the query compiler and the `llm_call` trace. Only the model's
 * judgement is faked, and the model's judgement is the one thing an e2e cannot assert anyway.
 *
 * It answers all three of Stage 6's prompts, keyed on the strict schema name the transport sends.
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.MODEL_STUB_PORT ?? 3202)

/** Filled in from `filters`; every payload property must be present for the schema to accept it. */
function filter(partial) {
  return {
    value: null,
    values: null,
    from: null,
    to: null,
    preset: null,
    n: null,
    unit: null,
    ...partial,
  }
}

function answer({
  objectType = 'contact',
  subject,
  filters = [],
  understood = true,
  declineReason = null,
}) {
  return {
    understood,
    objectType,
    subject,
    declineReason,
    filters: filters.map(filter),
  }
}

/**
 * Keyed on a word in the question, so one spec can ask several things and each is deterministic.
 * The first match wins, and anything unmatched declines — which is a real answer shape too.
 */
const SCRIPT = [
  {
    match: /munich/i,
    answer: answer({
      subject: 'contacts in Munich',
      filters: [{ field: 'city', op: 'equals', value: 'Munich' }],
    }),
  },
  {
    match: /berlin/i,
    answer: answer({
      objectType: 'organization',
      subject: 'organizations in Berlin',
      filters: [{ field: 'city', op: 'equals', value: 'Berlin' }],
    }),
  },
  {
    match: /nonsense|weather|rain/i,
    answer: answer({
      subject: '',
      understood: false,
      declineReason: 'I have no field for that in your network.',
    }),
  },
]

const DEFAULT = answer({ subject: 'everyone', filters: [] })

/**
 * The other two prompts, keyed the same way the transport identifies them: the strict
 * `response_format.json_schema.name`, which is `<prompt id>_v<version>` (`schemaNameOf`). Branching
 * on that rather than on the prompt text means a reworded prompt does not silently start getting
 * the wrong canned answer.
 */
function field(slug, value, confidence = 0.9) {
  return { slug, value, confidence }
}

function captureReply(note) {
  if (/nothing|milk/i.test(note)) {
    return {
      contact: null,
      organization: null,
      interaction: null,
      followUp: null,
      note: 'Nothing here names a person.',
    }
  }

  return {
    contact: {
      displayName: 'Anna Berger',
      fields: [
        field('first_name', 'Anna', 1),
        field('last_name', 'Berger', 1),
        field('city', 'Munich', 0.5),
        field('asks', 'climate-tech seed deals', 0.8),
      ],
    },
    organization: {
      displayName: 'Northstar Ventures',
      fields: [field('name', 'Northstar Ventures', 1)],
    },
    interaction: {
      type: 'Meeting',
      title: 'Bits & Pretzels',
      body: 'Looking for climate-tech seed deals.',
      occurredOn: null,
    },
    followUp: { title: 'Follow up with Anna', dueOn: '2026-12-31', notes: null },
    note: null,
  }
}

const SUMMARY = {
  summary:
    'An investor at Northstar Ventures in Munich. Currently looking for climate-tech seed deals.',
}

function replyFor(schemaName, message) {
  if (schemaName.startsWith('quick_capture_extract')) return captureReply(message)
  if (schemaName.startsWith('contact_summary')) return SUMMARY
  return reply(message)
}

/**
 * The **question**, not the whole user message.
 *
 * The rendered prompt ends with `Question: …` and begins with `Today is 2026-09-05 in
 * Europe/Berlin` — so matching /berlin/ against the whole message matched the *timezone* and
 * answered a question about German organizations to "what is the weather like?". Found by the
 * spec that asserts the decline, which is exactly what it is for.
 */
function questionIn(message) {
  const marker = message.lastIndexOf('Question:')
  return marker === -1 ? message : message.slice(marker + 'Question:'.length)
}

function reply(message) {
  const question = questionIn(message)
  return SCRIPT.find((entry) => entry.match.test(question))?.answer ?? DEFAULT
}

const server = createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"ok":true}')
    return
  }

  if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
    response.writeHead(404).end()
    return
  }

  let body = ''
  request.on('data', (chunk) => (body += chunk))
  request.on('end', () => {
    let message
    let schemaName = ''
    try {
      const parsed = JSON.parse(body)
      message = String(parsed.messages?.at(-1)?.content ?? '')
      schemaName = String(parsed.response_format?.json_schema?.name ?? '')
    } catch {
      message = ''
    }

    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        id: 'gen-e2e',
        model: 'stub/model',
        provider: 'e2e-stub',
        choices: [
          {
            message: { role: 'assistant', content: JSON.stringify(replyFor(schemaName, message)) },
          },
        ],
        // A real cost, so the e2e exercises ADR-070's counter rather than the unreported branch.
        usage: { prompt_tokens: 900, completion_tokens: 60, cost: 0.000_42 },
      }),
    )
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`model stub on http://127.0.0.1:${String(PORT)}`)
})
