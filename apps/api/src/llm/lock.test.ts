/**
 * `prompts.lock.json` against what the prompts emit right now (ADR-067).
 *
 * **The check is written and skips loudly**, which is the same shape ADR-095 chose for the pooler
 * test and for the same reason: a skipped test with a named reason is visible in every run's
 * output, while an absent test is visible nowhere. ADR-067 is explicit that the lock is enforced
 * *from the end of Stage 6*, because enforcing it during active iteration turns every wording tweak
 * into a version bump plus a stale fixture — and enforcing it from Stage 1 gated nothing, since no
 * prompts existed.
 *
 * Flipping `LOCK_ENFORCED` to `true` at the end of Stage 6's second half is the whole change.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { LOCK_PATH, buildLock } from '../bin/llm-relock.ts'

/** Stage 6, second half. Flip this, run `pnpm llm:relock`, commit the diff. */
const LOCK_ENFORCED = false

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
