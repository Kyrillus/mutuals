/**
 * `pnpm llm:relock` — rewrites `apps/api/src/llm/prompts.lock.json` (ADR-067).
 *
 * The lock is over three things per prompt: the id and version, the hash of the *rendered sample*,
 * and the emitted JSON schema. The sample is what makes the hash mean something — it is a real,
 * type-checked input living beside the prompt, so a wording change moves the hash and a refactor
 * that renames an input field cannot leave a stale fixture behind quietly.
 *
 * **Enforcement starts at the end of Stage 6, not now.** Enforcing it during active iteration turns
 * every comma into a version bump plus a re-record; enforcing it from Stage 1 gated nothing, because
 * no prompts existed. `lock.test.ts` holds the check and skips with that reason until then.
 */
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { PROMPTS } from '../llm/prompts/index.ts'
import { outputJsonSchema } from '../llm/prompts/spec.ts'
import { promptTemplateHash } from '../llm/trace.ts'

export const LOCK_PATH = fileURLToPath(new URL('../llm/prompts.lock.json', import.meta.url))

export interface LockEntry {
  readonly id: string
  readonly version: number
  readonly taskKind: string
  /** ADR-068's `prompt_hash`: the template, not the rendered input. Constant per version. */
  readonly promptHash: string
  readonly schema: unknown
}

export function buildLock(): { readonly prompts: readonly LockEntry[] } {
  return {
    prompts: PROMPTS.map((prompt) => ({
      id: prompt.id,
      version: prompt.version,
      taskKind: prompt.taskKind,
      promptHash: promptTemplateHash(prompt.renderSample()),
      schema: outputJsonSchema(prompt),
    })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  }
}

if (import.meta.filename === process.argv[1]) {
  const lock = buildLock()
  await writeFile(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`, 'utf8')
  for (const entry of lock.prompts) {
    console.log(`${entry.id} v${String(entry.version)}  ${entry.promptHash.slice(0, 12)}`)
  }
  console.log(`Wrote ${LOCK_PATH}`)
}
