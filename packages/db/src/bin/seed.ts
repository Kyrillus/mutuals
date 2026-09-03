#!/usr/bin/env node
/**
 * `pnpm seed` — fill the database with the demo network of §8.1.
 *
 * ```
 * pnpm seed                          reset, then seed, against DATABASE_URL
 * pnpm seed -- --assert-counts       ...and fail loudly if the result is not what it should be
 * pnpm seed -- --seed=7 --today=2026-06-01   a different, still reproducible network
 * pnpm seed -- --keep                add to what is already there instead of resetting
 * ```
 *
 * It resets by default, because CI runs `pnpm seed -- --assert-counts` on every push and a seed
 * that appended would fail the second time it ran.
 */
import process from 'node:process'

import { parseCivil, todayIn, type CivilDate } from '@mutuals/core'

import { makeDb, resolveConnectionString } from '../client.ts'
import { assertSchemaCurrent } from '../migrate.ts'
import { seedDatabase, SeedAssertionError } from '../seed/index.ts'
import { SEED_DEFAULTS } from '../seed/plan.ts'

const green = (text: string): string => `\u001b[32m${text}\u001b[0m`
const red = (text: string): string => `\u001b[31m${text}\u001b[0m`
const dim = (text: string): string => `\u001b[2m${text}\u001b[0m`
const bold = (text: string): string => `\u001b[1m${text}\u001b[0m`

const args = process.argv.slice(2)
const flag = (name: string): boolean => args.includes(`--${name}`)
const option = (name: string): string | undefined =>
  args
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=')

const TIME_ZONE = process.env.MUTUALS_TIME_ZONE ?? 'Europe/Berlin'

function resolveToday(): CivilDate {
  const given = option('today')
  if (given === undefined) return todayIn(TIME_ZONE, new Date())
  const parsed = parseCivil(given)
  if (!parsed.ok) {
    console.error(`${red('✗')} --today=${given} is not a calendar date (YYYY-MM-DD).`)
    process.exit(2)
  }
  return parsed.value
}

const seedValue = Number(option('seed') ?? SEED_DEFAULTS.seed)
if (!Number.isInteger(seedValue)) {
  console.error(`${red('✗')} --seed must be an integer.`)
  process.exit(2)
}

const databaseName = new URL(resolveConnectionString()).pathname.replace(/^\//, '')
const db = makeDb({ applicationName: 'mutuals-seed', max: 4 })
const startedAt = Date.now()

try {
  await assertSchemaCurrent(db)

  const today = resolveToday()
  console.log(dim(`database: ${databaseName}   seed: ${seedValue}   today: ${today}`))

  const result = await seedDatabase(db, {
    seed: seedValue,
    today,
    reset: !flag('keep'),
    assertCounts: flag('assert-counts'),
    timeZone: TIME_ZONE,
  })

  const { counts, metrics } = result
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)

  console.log('')
  console.log(`${green('✓')} ${bold('Seeded')} in ${seconds}s`)
  console.log(`    ${counts.contacts} contacts, ${counts.organizations} organizations`)
  console.log(`    ${counts.interactions} interactions, ${counts.followUps} follow-ups`)
  console.log(
    `    ${counts.facts} facts → ${counts.attributeValues} values + ${counts.recordLinks} links`,
  )
  console.log(`    ${counts.identifiers} identifiers, ${counts.searchDocuments} search documents`)
  console.log(
    `    ${counts.contactViews} contact views, ${counts.organizationViews} organization view`,
  )
  console.log(
    `    ${counts.askOfferMatches} tags one person asks for and another offers ${dim('(§4.1)')}`,
  )
  console.log(
    `    warmth: ${Object.entries(metrics.warmthBuckets)
      .map(([bucket, n]) => `${bucket}=${n}`)
      .join('  ')}`,
  )
  if (flag('assert-counts')) console.log(`${green('✓')} counts asserted`)
  console.log('')
} catch (error) {
  if (error instanceof SeedAssertionError) {
    console.error(`\n${red('✗')} ${error.message}\n`)
  } else {
    console.error(`\n${red('✗')} The seed failed. Nothing was committed.`)
    console.error(error)
  }
  process.exitCode = 1
} finally {
  await db.destroy()
}
