/**
 * `pnpm llm:record` — makes one **live** call and writes the answer into `fixtures/llm/` (ADR-068).
 *
 * This spends money. It is a hand-run tool and never part of `verify`: that is the whole reason
 * `LLM_MODE=replay` exists, so the e2e suite and a fork's CI can exercise the real parse, the real
 * validation and the real trace with no key and no network.
 *
 * The fixture is keyed by ADR-068's five parts, so re-recording after a prompt edit writes a *new*
 * file rather than overwriting the old one's answer under a stale key — a reworded prompt must not
 * silently replay the answer to the question it used to ask.
 *
 *   pnpm llm:record --prompt ask.filter
 *   pnpm llm:record --prompt ask.filter --question "Who have I not spoken to in six months?"
 */
import { makeDb } from '@mutuals/db'

import { loadEnv } from '../env.ts'
import { askFilterPrompt } from '../llm/prompts/ask-filter.ts'
import { promptById } from '../llm/prompts/index.ts'
import { outputJsonSchema, schemaNameOf } from '../llm/prompts/spec.ts'
import { writeFixture } from '../llm/replay.ts'
import { modelFor } from '../llm/settings.ts'
import { OpenAiCompatibleProvider } from '../llm/transport.ts'
import { inputHash, promptTemplateHash } from '../llm/trace.ts'

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const promptId = flag('prompt') ?? 'ask.filter'
const registered = promptById(promptId)
if (registered === undefined) {
  console.error(`No prompt called "${promptId}".`)
  process.exit(1)
}

const env = loadEnv()
if (env.OPENROUTER_API_KEY === undefined) {
  console.error('llm:record makes a real, billable call. Set OPENROUTER_API_KEY first.')
  process.exit(1)
}

const db = makeDb({ connectionString: env.DATABASE_URL, applicationName: 'mutuals-llm-record' })

try {
  // Only `ask.filter` exists today. When the second half adds two more, this becomes a lookup
  // rather than a branch — and the `sample` is what makes that possible without a payload file.
  const question = flag('question')
  const input =
    question === undefined
      ? askFilterPrompt.sample
      : { ...askFilterPrompt.sample, question, problems: [] }

  const model = await modelFor(db, env, registered.taskKind)
  const messages = askFilterPrompt.render(input)

  const provider = new OpenAiCompatibleProvider({
    baseUrl: env.LLM_BASE_URL,
    apiKey: env.OPENROUTER_API_KEY,
    totalTimeoutMs: env.LLM_TOTAL_TIMEOUT_MS,
    attemptTimeoutMs: env.LLM_ATTEMPT_TIMEOUT_MS,
  })

  console.log(`Asking ${model} — this call is billable.`)
  const response = await provider.complete({
    model,
    messages,
    schemaName: schemaNameOf(registered),
    schema: outputJsonSchema(registered),
    ...(askFilterPrompt.temperature === undefined
      ? {}
      : { temperature: askFilterPrompt.temperature }),
    ...(askFilterPrompt.maxTokens === undefined ? {} : { maxTokens: askFilterPrompt.maxTokens }),
  })

  // Validated before it is written. A fixture that does not parse is a test that fails for the
  // wrong reason six weeks later, and the production schema is the only thing worth checking with.
  const parsed = askFilterPrompt.output.safeParse(JSON.parse(response.content))
  if (!parsed.success) {
    console.error('The live answer did not validate; nothing was written.')
    console.error(parsed.error.issues)
    process.exit(1)
  }

  const name = await writeFixture(
    {
      promptId: registered.id,
      promptVersion: registered.version,
      promptHash: promptTemplateHash(registered.renderSample()),
      modelRequested: model,
      inputHash: inputHash(input),
    },
    {
      recordedAt: new Date().toISOString(),
      promptId: registered.id,
      promptVersion: registered.version,
      modelRequested: model,
      note: question ?? 'the prompt’s own sample input',
      responseBody: response.responseBody,
      modelServed: response.modelServed,
      upstreamProvider: response.upstreamProvider,
      generationId: response.generationId,
      httpStatus: response.httpStatus,
    },
  )

  const cost = response.usage.costUsd
  console.log(`Wrote fixtures/llm/${name}`)
  console.log(`Cost: ${cost === null ? 'not reported' : `$${cost.toFixed(6)}`}`)
} finally {
  // The `llm_call` trace is deliberately not written here: this is a tool, not a task, and its
  // spending should not move the product's daily counter.
  await db.destroy()
}
