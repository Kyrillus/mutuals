/**
 * §13's **R5**, measured rather than predicted.
 *
 * > *A 10k-row import is the peak write event and it is the least-tested path.* ~150k facts, ~150k
 * > value rows, ~300k composite-FK parent probes, one `COPY`, one set-based projection, and the
 * > duplicate probe for every identifier. **Falsifier:** … a recorded wall-clock in
 * > `ARCHITECTURE.md`. If it exceeds ~60 s, the documented fix is dropping and rebuilding
 * > `av_trgm_idx` around the batch.
 *
 * Stage 5's acceptance test proved the *correctness* half — the LinkedIn fixture imports twice and
 * creates nothing the second time — over 31 rows. This is the other half, and the reason it is its
 * own file: it generates ten thousand rows, so it takes minutes rather than seconds and has no
 * business running on every push.
 *
 * **Opt-in, and it skips loudly**, the shape ADR-095 chose for the pooler test and ADR-072 for the
 * live model call. A skipped test with a named reason is visible in every run's output; an absent
 * one is visible nowhere, and this claim has been carried on reasoning since Stage 1.
 *
 *     MUTUALS_IMPORT_PERF=1 pnpm test:integration
 *
 * **It asserts correctness and prints the clock; it does not assert a latency.** The first version
 * failed on R5's own 60 s figure, which was tempting and wrong twice over: ADR-078 rules out latency
 * assertions in as many words, and a gate that is permanently red because a prediction was optimistic
 * is not a gate. What R5's falsifier actually asked for is "a recorded wall-clock in
 * `ARCHITECTURE.md`" — so the number is printed here, written down there, and the risk register says
 * what it turned out to be.
 */
import { describe, expect, it } from 'vitest'
import { testDb } from '@mutuals/db/test-support'

import { api, upload } from '../test-support/app.ts'

const ENABLED = process.env.MUTUALS_IMPORT_PERF === '1'

/**
 * R5's own prediction, kept for the message rather than for an assertion.
 *
 * Measured 2026-09-05: **122 s to stage and 176 s to commit** — about five minutes end to end, some
 * five times this. R5's documented remedy (dropping and rebuilding `av_trgm_idx` around the batch)
 * is therefore indicated and has **not** been attempted; nobody has profiled where the five minutes
 * actually go, and rebuilding one GIN index on a hunch is not a fix, it is a guess with downtime.
 */
const R5_PREDICTED_MS = 60_000

/** §6.8 promises 10,000 rows. Measuring 9,999 would be measuring something else. */
const ROWS = 10_000

interface Detail {
  batch: {
    id: string
    status: string
    rowCount: number
    counts: { total: number; withErrors: number; duplicates: number; willImport: number }
    createdCount: number
  }
}

/**
 * Names that vary the way real ones do.
 *
 * The first version of this generator wrote `Perf00001 Tester00001`, `Perf00002 Tester00002` …, and
 * **half the export was flagged as duplicates of itself** — correctly. Consecutive numbered names
 * are near-identical to a trigram, ADR-099 put the fuzzy threshold at 0.65, and 500 shared companies
 * gave `name_fuzzy_org_same` the organisation it also needs. That is the matcher working; it just
 * meant the measurement was of the *skip* path rather than the write path. A 100 x 100 cross product
 * of unrelated names has no such structure.
 */
const FIRST_NAMES = [
  'Anna',
  'Bruno',
  'Clara',
  'Dmitri',
  'Elif',
  'Farid',
  'Greta',
  'Hugo',
  'Ingrid',
  'Jonas',
  'Katarina',
  'Lukas',
  'Marta',
  'Niels',
  'Oskar',
  'Petra',
  'Quentin',
  'Rosa',
  'Sven',
  'Tomas',
  'Ulrike',
  'Viktor',
  'Wanda',
  'Xenia',
  'Yusuf',
  'Zofia',
  'Andrei',
  'Beata',
  'Cosmin',
  'Dorota',
  'Emil',
  'Franka',
  'Gabor',
  'Helena',
  'Igor',
  'Julia',
  'Kasper',
  'Lena',
  'Mikael',
  'Nadia',
  'Olav',
  'Paulina',
  'Rafal',
  'Sofia',
  'Timo',
  'Ursula',
  'Vidar',
  'Wiebke',
  'Yara',
  'Zeno',
] as const

const LAST_NAMES = [
  'Berger',
  'Novak',
  'Fischer',
  'Kowalski',
  'Andersson',
  'Dubois',
  'Rossi',
  'Hakansson',
  'Weber',
  'Lindqvist',
  'Moreau',
  'Schmitt',
  'Varga',
  'Nilsen',
  'Popescu',
  'Jansen',
  'Costa',
  'Meyer',
  'Larsen',
  'Horvat',
  'Bianchi',
  'Nowak',
  'Krause',
  'Vermeulen',
  'Ivanov',
  'Silva',
  'Hoffmann',
  'Eriksen',
  'Kaminski',
  'Ferrari',
  'Bauer',
  'Dvorak',
  'Olsen',
  'Marchetti',
  'Zieliński',
  'Haas',
  'Lindgren',
  'Petrov',
  'Romano',
  'Blom',
  'Keller',
  'Sorensen',
  'Tanaka',
  'Brandt',
  'Mancini',
  'Kovac',
  'Lehtinen',
  'Baumann',
  'Duarte',
  'Wolff',
] as const

/**
 * A LinkedIn export of `rows` distinct people.
 *
 * Every row carries an email *and* a LinkedIn URL, so every row costs two identifier probes on the
 * way in and two identifier writes on the way out — which is the expensive shape, and the one §6.8
 * actually meets.
 */
function linkedInExport(rows: number): Buffer {
  const lines: string[] = [
    'Notes:',
    '"When exporting your connection data, you may notice that some of the email addresses are missing."',
    '',
    'First Name,Last Name,URL,Email Address,Company,Position,Connected On',
  ]
  for (let i = 0; i < rows; i += 1) {
    const first = FIRST_NAMES[i % FIRST_NAMES.length] ?? 'Anna'
    const last = LAST_NAMES[Math.floor(i / FIRST_NAMES.length) % LAST_NAMES.length] ?? 'Berger'
    const n = String(i).padStart(5, '0')
    lines.push(
      `${first},${last},https://www.linkedin.com/in/${first.toLowerCase()}-${last.toLowerCase()}-${n},` +
        `${first.toLowerCase()}.${last.toLowerCase()}.${n}@example.com,` +
        `Perf Company ${String(i % 500)},Engineer,01 Jan 2026`,
    )
  }
  return Buffer.from(`${lines.join('\n')}\n`, 'utf8')
}

async function contactCount(): Promise<number> {
  const row = await testDb()
    .selectFrom('record')
    .select((eb) => eb.fn.countAll<string>().as('total'))
    .where('object_type', '=', 'contact')
    .executeTakeFirst()
  return Number(row?.total ?? 0)
}

async function factCount(): Promise<number> {
  const row = await testDb()
    .selectFrom('fact')
    .select((eb) => eb.fn.countAll<string>().as('total'))
    .executeTakeFirst()
  return Number(row?.total ?? 0)
}

describe('R5 — the peak write event', () => {
  it.skipIf(!ENABLED)(
    `imports ${String(ROWS)} rows completely, and records what it cost`,
    async () => {
      const file = linkedInExport(ROWS)

      const uploadedAt = Date.now()
      const uploaded = await upload<Detail>(
        '/api/v1/import-batches',
        { name: 'perf_connections.csv', content: file },
        { objectType: 'contact', source: 'linkedin' },
      )
      const parseMs = Date.now() - uploadedAt

      expect(uploaded.status).toBe(201)
      expect(uploaded.body.batch.rowCount).toBe(ROWS)

      const batchId = uploaded.body.batch.id
      const before = await contactCount()

      const startedAt = Date.now()
      // `create` for every flagged row: R5 is about the peak *write* event, and letting the
      // matcher skip rows would measure how fast the importer declines to do work.
      const committed = await api.post(`/api/v1/import-batches/${batchId}/commit`, {
        bulkDecision: 'create',
      })
      const commitMs = Date.now() - startedAt

      const detail = await api.get<Detail>(`/api/v1/import-batches/${batchId}`)
      const landed = (await contactCount()) - before

      // Printed before anything is asserted, deliberately: a measurement that only appears when the
      // test passes is a measurement nobody has when it fails, which is the run you most want it in.
      console.info(
        `\nR5 — ${String(ROWS)} rows: parse+stage ${String(parseMs)} ms, commit ${String(commitMs)} ms, ` +
          `${String(landed)} contacts, ${String(await factCount())} facts. ` +
          `R5 predicted ${String(R5_PREDICTED_MS)} ms.\n`,
      )

      // The inline queue runs the handler after the enqueueing transaction commits, so by the time
      // the request has returned the work is done and the status is 200 rather than pg-boss's 202.
      // What actually has to be true: every row landed, the batch says so, and each contact carries
      // the facts the file described. How long it took is recorded above and argued in
      // `ARCHITECTURE.md` — it is a measurement, not a pass/fail.
      expect(committed.status).toBe(200)
      expect(detail.body.batch.status).toBe('completed')
      expect(landed).toBe(ROWS)
      expect(await factCount()).toBeGreaterThanOrEqual(ROWS * 3)
    },
    20 * 60_000,
  )

  it.runIf(!ENABLED)(
    'is skipped: set MUTUALS_IMPORT_PERF=1 to measure R5 (minutes, not seconds)',
    () => {
      expect(ENABLED).toBe(false)
    },
  )
})
