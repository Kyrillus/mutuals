/**
 * `setupFiles` for the `integration` project: run once per test *file*, in the worker process.
 *
 * So nothing expensive happens here. Opening the clone and its pool is a per-process singleton
 * cached on `globalThis` (ADR-073); all this file does per file is await it, and empty the database
 * before each test.
 */
import { beforeAll, beforeEach } from 'vitest'
import { getTestDb, resetDatabase } from './database.ts'

beforeAll(async () => {
  await getTestDb()
})

// Between tests, not after them: a failed test that leaves rows behind should still be able to
// leave them behind, so they can be looked at.
beforeEach(async () => {
  await resetDatabase()
})
