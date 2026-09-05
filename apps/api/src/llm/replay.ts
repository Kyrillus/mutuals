/**
 * `LLM_MODE=replay`: fixture files, and nothing else (ADR-068).
 *
 * The correction this file exists to hold: the first design fell back to "the newest matching
 * `llm_call` row" when no fixture was found. That makes a replay test depend on whichever database
 * the developer happens to be pointing at — green locally because they clicked around last week,
 * red in CI where the table is empty. Non-determinism is the exact thing replay removes, so a
 * missing fixture **fails loudly**, with the command that records one in the message.
 *
 * The key is ADR-068's five parts: prompt id, prompt version, prompt (template) hash, the model
 * requested, and the hash of the task input. Change any of them and the fixture no longer matches,
 * which is the point — a reworded prompt must not silently replay the answer to the old one.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { LlmFixtureMissingError } from './errors.ts'
import { sha256 } from './trace.ts'
import type { ChatResponse } from './types.ts'

export const FIXTURE_DIR = fileURLToPath(new URL('../../../../fixtures/llm/', import.meta.url))

export interface ReplayKey {
  readonly promptId: string
  readonly promptVersion: number
  readonly promptHash: string
  readonly modelRequested: string
  readonly inputHash: string
}

/**
 * The file name: readable prefix, then a short digest of the whole key.
 *
 * The prefix is there so a directory listing says what a fixture is for; the digest is what makes
 * it unique. Twelve hex characters over a five-part key is far past enough for a folder that will
 * hold tens of files, and a full 64-character name is unreadable in a diff.
 */
export function fixtureName(key: ReplayKey): string {
  const digest = sha256(
    [key.promptId, key.promptVersion, key.promptHash, key.modelRequested, key.inputHash].join(' '),
  ).slice(0, 12)
  return `${key.promptId.replace(/[^a-zA-Z0-9._-]/g, '_')}.v${String(key.promptVersion)}.${digest}.json`
}

export interface Fixture {
  /** Human-readable provenance. Nothing reads these; a person opening the file does. */
  readonly recordedAt: string
  readonly promptId: string
  readonly promptVersion: number
  readonly modelRequested: string
  readonly note?: string
  /** The provider's response body, verbatim, so replay runs the real parse and validate path. */
  readonly responseBody: unknown
  readonly modelServed: string | null
  readonly upstreamProvider: string | null
  readonly generationId: string | null
  readonly httpStatus: number
}

export async function readFixture(key: ReplayKey, dir = FIXTURE_DIR): Promise<ChatResponse> {
  const name = fixtureName(key)
  let text: string
  try {
    text = await readFile(new URL(name, pathToDirUrl(dir)), 'utf8')
  } catch {
    throw new LlmFixtureMissingError(
      [
        `No recorded answer for "${key.promptId}" v${String(key.promptVersion)} on ${key.modelRequested}.`,
        'LLM_MODE=replay reads fixtures only. Record one with:',
        `  pnpm llm:record --prompt ${key.promptId}`,
        `Expected file: fixtures/llm/${name}`,
      ].join('\n'),
    )
  }

  const fixture = JSON.parse(text) as Fixture
  const body = fixture.responseBody as { choices?: { message?: { content?: unknown } }[] }
  const content = body.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    throw new LlmFixtureMissingError(`fixtures/llm/${name} has no message content to replay.`)
  }

  return {
    content,
    // A replay costs nothing and says so, rather than replaying a price that was paid once.
    usage: {
      promptTokens: null,
      completionTokens: null,
      reasoningTokens: null,
      cachedTokens: null,
      costUsd: 0,
      costSource: 'free',
    },
    modelServed: fixture.modelServed,
    upstreamProvider: fixture.upstreamProvider,
    generationId: fixture.generationId,
    httpStatus: fixture.httpStatus,
    latencyMs: 0,
    requestBody: null,
    responseBody: fixture.responseBody,
  }
}

export async function writeFixture(
  key: ReplayKey,
  fixture: Fixture,
  dir = FIXTURE_DIR,
): Promise<string> {
  await mkdir(dir, { recursive: true })
  const name = fixtureName(key)
  await writeFile(new URL(name, pathToDirUrl(dir)), `${JSON.stringify(fixture, null, 2)}\n`, 'utf8')
  return name
}

function pathToDirUrl(dir: string): URL {
  return new URL(`file://${dir.endsWith('/') ? dir : `${dir}/`}`)
}
