#!/usr/bin/env node
/**
 * `pnpm dev` -- the one command (ADR-011).
 *
 * Finds or starts a database, migrates it, then runs the API (and the web app
 * once it exists). When it cannot do something itself it prints instructions a
 * non-developer can follow, and never installs anything without being asked.
 *
 * Zero dependencies on purpose: this is the first thing that runs on a fresh
 * clone, potentially before `pnpm install` has finished being understood.
 */
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync } from 'node:fs'
import net from 'node:net'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const bold = (s) => `\u001b[1m${s}\u001b[0m`
const dim = (s) => `\u001b[2m${s}\u001b[0m`
const red = (s) => `\u001b[31m${s}\u001b[0m`
const green = (s) => `\u001b[32m${s}\u001b[0m`

function die(message, ...detail) {
  console.error(`\n${red('✗')} ${bold(message)}\n`)
  for (const line of detail) console.error(`  ${line}`)
  console.error('')
  process.exit(1)
}

// --- 1. Environment ---------------------------------------------------------

const envPath = join(root, '.env')
if (!existsSync(envPath)) {
  copyFileSync(join(root, '.env.example'), envPath)
  console.log(
    `${green('✓')} Created ${bold('.env')} from .env.example. Defaults are fine to start.`,
  )
}
process.loadEnvFile(envPath)

const rawUrl = process.env.DATABASE_URL
if (!rawUrl) die('DATABASE_URL is not set.', 'Add it to .env — .env.example shows the shape.')

let url
try {
  url = new URL(rawUrl)
} catch {
  die(
    'DATABASE_URL could not be parsed.',
    'If your password contains @ : / or # it has to be percent-encoded.',
    dim('  A password of  p/w@rd  becomes  p%2Fw%40rd'),
    dim('  postgres://mutuals:p%2Fw%40rd@localhost:5432/mutuals_dev'),
  )
}

const host = url.hostname
const port = Number(url.port || 5432)
const dbName = url.pathname.replace(/^\//, '')
const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1'

// --- 2. Is anything listening? ----------------------------------------------

const canConnect = (h, p, timeout = 1500) =>
  new Promise((resolve) => {
    const socket = net.connect({ host: h, port: p })
    const done = (ok) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeout)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })

const has = (cmd) =>
  spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }).status ===
  0

/**
 * pnpm ships with Node but only lands on the PATH once `corepack enable pnpm` has been run, and this
 * script exists precisely for the person who has not done that yet. Going through corepack directly
 * is the honest fallback rather than telling them to go and read the README.
 */
const PM = has('pnpm') ? ['pnpm', []] : ['corepack', ['pnpm']]

function runPnpm(args, options = {}) {
  const [command, prefix] = PM
  const result = spawnSync(command, [...prefix, ...args], {
    cwd: root,
    stdio: 'inherit',
    ...options,
  })
  // spawnSync prints nothing at all when the binary itself is missing, so "the error above says why"
  // would be pointing at an empty space. Say what actually happened instead.
  if (result.error?.code === 'ENOENT') {
    die(
      `Could not run ${command}.`,
      'Node ships with corepack, which provides pnpm. Enable it once:',
      dim('  corepack enable pnpm'),
    )
  }
  return result
}

if (!(await canConnect(host, port))) {
  if (!isLocal) {
    die(
      `Cannot reach the database at ${host}:${port}.`,
      'That is not a local address, so nothing here can start it for you.',
      'Check the host is up, the port is open, and your network allows it.',
    )
  }

  console.log(`${dim('…')} Nothing is listening on ${host}:${port}. Starting one.`)

  if (has('docker')) {
    const up = spawnSync('docker', ['compose', 'up', '-d', '--wait'], {
      cwd: root,
      stdio: 'inherit',
    })
    if (up.status !== 0) die('`docker compose up` failed.', 'Is Docker Desktop running?')
    console.log(`${green('✓')} Database container is up.`)
  } else {
    die(
      'No database, and Docker is not installed.',
      'Pick whichever is easiest for you — any of these works:',
      '',
      `  ${bold('Docker Desktop')}  docker.com/products/docker-desktop  then run ${bold('pnpm dev')} again`,
      `  ${bold('Postgres.app')}    postgresapp.com — drag to Applications, click Initialize`,
      `  ${bold('Homebrew')}        brew install postgresql@18 pgvector && brew services start postgresql@18`,
      '',
      'Postgres.app and Homebrew need the databases created once:',
      dim('  createdb mutuals_dev && createdb mutuals_test'),
      'and DATABASE_URL in .env pointed at your own user instead of mutuals:mutuals.',
    )
  }
}

// --- 3. Migrate -------------------------------------------------------------

const migrate = runPnpm(['db:migrate'])
if (migrate.status !== 0) die('Migrations failed.', 'The migration output above says why.')

// --- 4. Run -----------------------------------------------------------------

console.log(`\n${green('✓')} Database ${bold(dbName)} on ${host}:${port} is migrated.\n`)

const children = []
const run = (name, args) => {
  const [command, prefix] = PM
  const child = spawn(command, [...prefix, ...args], { cwd: root, stdio: 'inherit' })
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`\n${red('✗')} ${name} exited with code ${code}.`)
      shutdown(code)
    }
  })
  children.push(child)
}

function shutdown(code = 0) {
  for (const c of children) c.kill('SIGTERM')
  process.exit(code)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

run('api', ['--filter', '@mutuals/api', 'dev'])
if (existsSync(join(root, 'apps/web/package.json'))) {
  run('web', ['--filter', '@mutuals/web', 'dev'])
}
