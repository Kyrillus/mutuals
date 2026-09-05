/**
 * `prompts.lock.json` against what the prompts emit right now (ADR-067).
 *
 * **Enforced from the end of Stage 6**, which ADR-067 chose deliberately: enforcing it during active
 * iteration turns every wording tweak into a version bump plus a stale fixture, and enforcing it
 * from Stage 1 gated nothing because no prompts existed. Through Stage 6's first half the check
 * lived here and skipped loudly, naming its own reason — the shape ADR-095 chose for the pooler
 * test, because a skipped test with a reason is visible in every run and an absent one is visible
 * nowhere.
 *
 * A prompt edited without `pnpm llm:relock` now fails CI.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { LOCK_PATH, buildLock } from '../bin/llm-relock.ts'

/**
 * On, as of the end of Stage 6 (ADR-067, ADR-114).
 *
 * Editing a prompt now fails CI until `pnpm llm:relock` is run and the diff committed — which is
 * the point: a reworded prompt with a stale lock is a recorded fixture that replays the answer to
 * a question the prompt no longer asks.
 */
const LOCK_ENFORCED = true

function committed(): unknown {
  return JSON.parse(readFileSync(LOCK_PATH, 'utf8'))
}

describe('prompts.lock.json', () => {
  it('exists and covers every registered prompt', () => {
    const onDisk = committed() as { prompts: { id: string }[] }
    expect(onDisk.prompts.map((entry) => entry.id)).toEqual(
      buildLock().prompts.map((entry) => entry.id),
    )
  })

  it.skipIf(!LOCK_ENFORCED)(
    'is what `pnpm llm:relock` writes right now (enforced from the end of Stage 6 — ADR-067)',
    () => {
      expect(committed()).toEqual(buildLock())
    },
  )

  it.runIf(!LOCK_ENFORCED)(
    'is NOT yet enforced: Stage 6 is still iterating on prompt wording (ADR-067)',
    () => {
      expect(LOCK_ENFORCED).toBe(false)
    },
  )
})
