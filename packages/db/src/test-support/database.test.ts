/**
 * The guard, tested without a database — because it is the thing that decides whether there will
 * be a database left.
 *
 * `globalSetup` drops every worker clone and rebuilds the template's schema from nothing. If
 * `TEST_DATABASE_URL` ever points at a development database, that is somebody's data. So the
 * assertion runs before the first destructive statement, and this is what proves it says no.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertSafeTestDatabase,
  databaseNameOf,
  TestWorkerOutOfRangeError,
  testWorkerId,
  UnsafeTestDatabaseError,
  workerDatabaseName,
} from './database.ts'

const SAFE = 'postgres://mutuals:mutuals@localhost:5432/mutuals_test'

describe('assertSafeTestDatabase', () => {
  it('accepts a local database whose name ends in _test', () => {
    expect(() => assertSafeTestDatabase(SAFE)).not.toThrow()
    expect(() =>
      assertSafeTestDatabase('postgres://mutuals@127.0.0.1:5432/anything_test'),
    ).not.toThrow()
  })

  it.each([
    ['the development database', 'postgres://mutuals@localhost:5432/mutuals_dev'],
    ['the end-to-end database', 'postgres://mutuals@localhost:5432/mutuals_e2e'],
    ['a name that merely contains _test', 'postgres://mutuals@localhost:5432/mutuals_test_backup'],
    ['no database at all', 'postgres://mutuals@localhost:5432/'],
  ])('refuses %s', (_case, url) => {
    expect(() => assertSafeTestDatabase(url)).toThrow(UnsafeTestDatabaseError)
  })

  it('refuses a name that is not a plain identifier', () => {
    expect(() => assertSafeTestDatabase('postgres://mutuals@localhost:5432/drop me_test')).toThrow(
      UnsafeTestDatabaseError,
    )
  })

  it('refuses something that is not a URL', () => {
    expect(() => assertSafeTestDatabase('mutuals_test')).toThrow(UnsafeTestDatabaseError)
  })

  it('refuses a host that is not this machine, unless it is told to', () => {
    const remote = 'postgres://mutuals@db.example.com:5432/mutuals_test'
    expect(() => assertSafeTestDatabase(remote)).toThrow(UnsafeTestDatabaseError)

    process.env.MUTUALS_ALLOW_DESTRUCTIVE = '1'
    expect(() => assertSafeTestDatabase(remote)).not.toThrow()
  })
})

describe('the worker database', () => {
  it('is the template plus the pool id', () => {
    expect(databaseNameOf(SAFE)).toBe('mutuals_test')
    expect(workerDatabaseName(SAFE, 3)).toBe('mutuals_test_w3')
  })

  it('is worker 1 when Vitest has not said otherwise', () => {
    delete process.env.VITEST_POOL_ID
    expect(testWorkerId()).toBe(1)
  })

  /**
   * Named, because the alternative is worker 5 connecting to a database that does not exist and a
   * failure that reads as "connection refused" (ADR-074).
   */
  it('is refused above MUTUALS_TEST_WORKERS', () => {
    process.env.VITEST_POOL_ID = '5'
    process.env.MUTUALS_TEST_WORKERS = '4'
    expect(() => testWorkerId()).toThrow(TestWorkerOutOfRangeError)
  })
})

const ENVIRONMENT = { ...process.env }

afterEach(() => {
  process.env = { ...ENVIRONMENT }
})
