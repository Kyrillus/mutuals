import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { ENV_KEYS, EnvError, parseEnv } from './env.ts'

const ENV_EXAMPLE = fileURLToPath(new URL('../../../.env.example', import.meta.url))

const MINIMAL = { DATABASE_URL: 'postgres://mutuals:mutuals@localhost:5432/mutuals_dev' }

/** Keys documented in `.env.example`, in the order they appear. */
async function documentedKeys(): Promise<string[]> {
  const text = await readFile(ENV_EXAMPLE, 'utf8')
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => line.slice(0, line.indexOf('=')))
    .filter((key) => key !== '')
}

describe('the documented environment', () => {
  // The rule from the stage brief, made checkable: every key in .env.example is in the schema, or
  // it does not belong in .env.example. Both directions, so an unread key is as loud as a missing
  // one.
  it('is exactly the schema', async () => {
    expect([...(await documentedKeys())].sort()).toEqual([...ENV_KEYS])
  })
})

describe('parseEnv', () => {
  it('needs only DATABASE_URL, and fills the rest from documented defaults', () => {
    const env = parseEnv(MINIMAL)
    expect(env.PORT).toBe(3001)
    expect(env.NODE_ENV).toBe('development')
    expect(env.LOG_LEVEL).toBe('info')
    expect(env.DEFAULT_PHONE_REGION).toBe('DE')
    expect(env.DEFAULT_TIME_ZONE).toBe('Europe/Berlin')
    expect(env.LLM_DAILY_COST_LIMIT_USD).toBe(2)
  })

  it('reads an empty value as unset, so `LLM_MODEL_ANSWER=` is not a model called ""', () => {
    const env = parseEnv({ ...MINIMAL, LLM_MODEL_ANSWER: '', OPENROUTER_API_KEY: '   ' })
    expect(env.LLM_MODEL_ANSWER).toBeUndefined()
    expect(env.OPENROUTER_API_KEY).toBeUndefined()
  })

  it('fails fast, naming every key at once', () => {
    let message = ''
    try {
      parseEnv({ ...MINIMAL, PORT: 'http', DEFAULT_TIME_ZONE: 'Mars/Olympus' })
    } catch (error) {
      message = error instanceof EnvError ? error.message : String(error)
    }
    expect(message).toContain('PORT')
    expect(message).toContain('DEFAULT_TIME_ZONE')
    expect(message).toContain('Copy .env.example to .env')
  })

  it('refuses a DATABASE_URL that is not Postgres', () => {
    expect(() => parseEnv({ DATABASE_URL: 'mysql://localhost/mutuals' })).toThrow(EnvError)
  })

  it('refuses a two-letter region that is not two letters, and upper-cases the rest', () => {
    expect(parseEnv({ ...MINIMAL, DEFAULT_PHONE_REGION: 'de' }).DEFAULT_PHONE_REGION).toBe('DE')
    expect(() => parseEnv({ ...MINIMAL, DEFAULT_PHONE_REGION: 'DEU' })).toThrow(EnvError)
  })

  it('accepts an IANA timezone and refuses anything else', () => {
    expect(parseEnv({ ...MINIMAL, DEFAULT_TIME_ZONE: 'Pacific/Auckland' }).DEFAULT_TIME_ZONE).toBe(
      'Pacific/Auckland',
    )
    expect(() => parseEnv({ ...MINIMAL, DEFAULT_TIME_ZONE: 'CEST' })).toThrow(EnvError)
  })
})
