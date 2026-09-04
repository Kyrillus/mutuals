/**
 * The one fixture every spec inherits: a database in the state the migrations left it.
 *
 * `resetE2eDatabase` is the same truncate-and-restore the Vitest integration project runs between
 * its tests — literally the same `applyReset` (ADR-087). A spec therefore starts with no contacts,
 * no organizations and no user-created attributes, and creates exactly what it asserts on.
 */
import { test as base } from '@playwright/test'
import { resetE2eDatabase } from '@mutuals/db/test-support'

export const test = base.extend<{ freshDatabase: void }>({
  freshDatabase: [
    // Playwright reads the fixtures this one depends on off the destructuring pattern, so it has to
    // be a pattern even when it is empty. `no-empty-pattern` does not know that.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      await resetE2eDatabase()
      await use()
    },
    { auto: true },
  ],
})

export { expect } from '@playwright/test'
