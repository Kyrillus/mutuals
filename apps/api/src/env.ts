/**
 * The environment, validated once at boot (ADR-010).
 *
 * The whole documented surface is here: `env.test.ts` reads `.env.example` and asserts the two
 * agree in both directions, so a key that is documented but unread, or read but undocumented, is a
 * failing test rather than a support question. A missing or malformed value stops the process
 * before anything opens a socket, with `z.prettifyError`'s per-key report — the alternative is a
 * server that starts, serves for an hour, and then fails on the first request that needed the key.
 */
import { z } from 'zod'

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const

/** An unset variable and one set to the empty string mean the same thing in a `.env` file. */
const optionalText = z
  .string()
  .transform((value) => (value.trim() === '' ? undefined : value.trim()))
  .optional()

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

export const EnvSchema = z.object({
  // -- Database ------------------------------------------------------------------------------
  /** Only `docker-compose.yml` and the dev script read this; it is here so the pair stays in sync. */
  DB_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  /** Required by the integration suite, absent in production. */
  TEST_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).optional(),
  /** The same for the Playwright suite. The API never reads it; it is here so the pair stays in sync. */
  E2E_DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }).optional(),

  // -- API -----------------------------------------------------------------------------------
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),

  /**
   * Used until the user saves a Profile (ADR-045). Both are load-bearing: a national phone number
   * cannot be normalised to E.164 without a region, and warmth cannot decay on whole civil days
   * without a timezone.
   */
  DEFAULT_PHONE_REGION: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, { error: 'Use a two-letter ISO country code, for example DE.' })
    .default('DE'),
  DEFAULT_TIME_ZONE: z
    .string()
    .trim()
    .refine(isTimeZone, { error: 'Not an IANA timezone name, for example Europe/Berlin.' })
    .default('Europe/Berlin'),

  // -- LLM (Stage 6; the app runs fine with all of these unset) --------------------------------
  OPENROUTER_API_KEY: optionalText,
  LLM_BASE_URL: z.url().default('https://openrouter.ai/api/v1'),
  LLM_MODEL_EXTRACTION: optionalText,
  LLM_MODEL_ANSWER: optionalText,
  LLM_MODEL_SUMMARY: optionalText,
  /** A hard stop checked before every request. 0 disables the cap. */
  LLM_DAILY_COST_LIMIT_USD: z.coerce.number().min(0).default(2),
})

export type Env = z.output<typeof EnvSchema>

/** Every key the schema knows. `env.test.ts` compares this set against `.env.example`. */
export const ENV_KEYS: readonly string[] = Object.freeze(Object.keys(EnvSchema.shape).sort())

export class EnvError extends Error {
  override readonly name = 'EnvError'
}

/**
 * Parses an environment. Empty strings are dropped first, so `LLM_MODEL_ANSWER=` in a `.env` file
 * is "not configured" rather than a model called "".
 */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  const present: Record<string, string> = {}
  for (const key of ENV_KEYS) {
    const value = raw[key]
    if (value !== undefined && value.trim() !== '') present[key] = value
  }

  const parsed = EnvSchema.safeParse(present)
  if (!parsed.success) {
    throw new EnvError(
      `The environment is not usable:\n${z.prettifyError(parsed.error)}\n\n` +
        'Copy .env.example to .env and fill in what is missing.',
    )
  }
  return parsed.data
}

export function loadEnv(): Env {
  return parseEnv(process.env)
}
