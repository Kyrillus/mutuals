#!/usr/bin/env node
/**
 * `pnpm db:up` -- bring a database up and create the three databases the project
 * uses: mutuals_dev, mutuals_test, mutuals_e2e.
 *
 * It detects and instructs. It never installs anything and never escalates to
 * root: an npm script in a public repo that runs `brew install` or `sudo apt-get`
 * is not something a stranger should be asked to run (ADR-012).
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const bold = (s) => `\u001b[1m${s}\u001b[0m`
const dim = (s) => `\u001b[2m${s}\u001b[0m`
const green = (s) => `\u001b[32m${s}\u001b[0m`
const red = (s) => `\u001b[31m${s}\u001b[0m`

const envPath = join(root, '.env')
if (existsSync(envPath)) process.loadEnvFile(envPath)

const has = (cmd) =>
  spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' })
    .status === 0

const DATABASES = ['mutuals_dev', 'mutuals_test', 'mutuals_e2e']

if (has('docker')) {
  console.log(`${dim('…')} Starting the database container.`)
  const up = spawnSync('docker', ['compose', 'up', '-d', '--wait'], { cwd: root, stdio: 'inherit' })
  if (up.status !== 0) {
    console.error(`\n${red('✗')} ${bold('docker compose up failed.')} Is Docker Desktop running?\n`)
    process.exit(1)
  }

  for (const db of DATABASES) {
    // `CREATE DATABASE` has no IF NOT EXISTS, so an existing database is a
    // successful no-op rather than an error worth showing.
    const made = spawnSync(
      'docker',
      ['compose', 'exec', '-T', 'db', 'psql', '-U', 'mutuals', '-d', 'postgres', '-c', `CREATE DATABASE ${db}`],
      { cwd: root, encoding: 'utf8' },
    )
    const already = (made.stderr ?? '').includes('already exists')
    console.log(`${green('✓')} ${db}${already ? dim(' (already there)') : ''}`)
  }

  const version = spawnSync(
    'docker',
    ['compose', 'exec', '-T', 'db', 'psql', '-U', 'mutuals', '-d', 'mutuals_dev', '-At', '-c', 'select version()'],
    { cwd: root, encoding: 'utf8' },
  )
  console.log(`\n${dim((version.stdout ?? '').trim())}\n`)
  console.log(`Next: ${bold('pnpm dev')}\n`)
  process.exit(0)
}

if (has('createdb')) {
  console.log(`${dim('…')} Docker is not installed; using the local Postgres on your PATH.`)
  for (const db of DATABASES) {
    const made = spawnSync('createdb', [db], { encoding: 'utf8' })
    const already = (made.stderr ?? '').includes('already exists')
    if (made.status !== 0 && !already) {
      console.error(`${red('✗')} Could not create ${db}: ${(made.stderr ?? '').trim()}`)
      process.exit(1)
    }
    console.log(`${green('✓')} ${db}${already ? dim(' (already there)') : ''}`)
  }
  console.log(
    `\n${bold('One thing to check:')} DATABASE_URL in .env points at ${dim('mutuals:mutuals')} by`,
  )
  console.log(`default, which suits the Docker setup. For a local Postgres it is usually just`)
  console.log(`${dim('  postgres://localhost:5432/mutuals_dev')}\n`)
  console.log(`Next: ${bold('pnpm dev')}\n`)
  process.exit(0)
}

console.error(`\n${red('✗')} ${bold('No Postgres, and no Docker.')}\n`)
console.error('  Pick whichever is easiest — any of these works:\n')
console.error(`  ${bold('Docker Desktop')}  docker.com/products/docker-desktop`)
console.error(`  ${bold('Postgres.app')}    postgresapp.com — drag to Applications, click Initialize`)
console.error(`  ${bold('Homebrew')}        brew install postgresql@18 pgvector`)
console.error(`                  brew services start postgresql@18\n`)
console.error(`  Then run ${bold('pnpm db:up')} again.\n`)
process.exit(1)
