#!/usr/bin/env node
/**
 * `pnpm db:reproject` — rebuild every derived value from the `fact` log alone (ADR-020, ADR-025).
 *
 * ```
 * pnpm db:reproject                rebuild attribute_value, record_link and search_document
 * pnpm db:reproject -- --verify    digest, rebuild, digest again, and name every record that moved
 * pnpm db:reproject -- --record=<uuid> [--record=<uuid>]   just these
 * ```
 *
 * `--verify` is the safety argument for keeping a derived copy at all: the projection is allowed
 * to exist only because a full rebuild reproduces it exactly. When it fails it prints the
 * diverging record ids, because `expected 'a3f…' to be 'b71…'` tells nobody anything.
 */
import process from 'node:process'

import { makeDb, resolveConnectionString } from '../client.ts'
import { assertSchemaCurrent } from '../migrate.ts'
import { reprojectAll, reprojectRecords, verifyProjection } from '../reproject.ts'

const green = (text: string): string => `\u001b[32m${text}\u001b[0m`
const red = (text: string): string => `\u001b[31m${text}\u001b[0m`
const dim = (text: string): string => `\u001b[2m${text}\u001b[0m`

const args = process.argv.slice(2)
const verify = args.includes('--verify')
const records = args
  .filter((arg) => arg.startsWith('--record='))
  .map((arg) => arg.slice('--record='.length))

if (verify && records.length > 0) {
  console.error(`${red('✗')} --verify rebuilds the whole database; it cannot be scoped to records.`)
  process.exit(2)
}

const databaseName = new URL(resolveConnectionString()).pathname.replace(/^\//, '')
const db = makeDb({ applicationName: 'mutuals-reproject', max: 2 })
const startedAt = Date.now()

try {
  await assertSchemaCurrent(db)
  console.log(dim(`database: ${databaseName}`))

  if (verify) {
    const report = await verifyProjection(db)
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
    if (report.ok) {
      console.log(
        `${green('✓')} the projection is byte-identical to a full rebuild ` +
          `(${Object.keys(report.after).length} records, ${seconds}s)`,
      )
    } else {
      console.error(`\n${red('✗')} ${report.diverged.length} record(s) differ after a rebuild:\n`)
      for (const id of report.diverged.slice(0, 20)) {
        console.error(
          `    ${id}  ${dim(`${report.before[id] ?? '—'} → ${report.after[id] ?? '—'}`)}`,
        )
      }
      if (report.diverged.length > 20) {
        console.error(`    ${dim(`… and ${report.diverged.length - 20} more`)}`)
      }
      console.error('')
      process.exitCode = 1
    }
  } else {
    const result = records.length > 0 ? await reprojectRecords(db, records) : await reprojectAll(db)
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
    console.log(
      `${green('✓')} reprojected ${result.records} record(s), ` +
        `${result.identifiers} new identifier(s), ${seconds}s`,
    )
  }
} catch (error) {
  console.error(`\n${red('✗')} Reprojection failed. Nothing was committed.`)
  console.error(error)
  process.exitCode = 1
} finally {
  await db.destroy()
}
