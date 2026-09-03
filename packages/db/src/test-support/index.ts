/**
 * `@mutuals/db/test-support` — what an integration test is allowed to know about the database.
 *
 * `global-setup.ts` and `setup.ts` are entry points Vitest loads by path, not API, so they are
 * deliberately not re-exported here.
 */

export {
  MissingTestDatabaseUrlError,
  TestWorkerOutOfRangeError,
  TEST_WORKSPACE_ID,
  UnexpectedBaselineRowsError,
  UnsafeTestDatabaseError,
  assertSafeTestDatabase,
  closeTestDatabase,
  databaseNameOf,
  dropWorkerDatabases,
  ensureWorkerDatabase,
  getTestDb,
  requireTestDatabaseUrl,
  resetDatabase,
  testDb,
  testWorkerId,
  workerDatabaseName,
} from './database.ts'

export { attributeIdBySlug, optionIdByKey } from './fixtures.ts'
