/**
 * ADR-071, checked rather than trusted: the LLM module is reachable from four places and no others.
 *
 * The rule is a `no-restricted-imports` zone in `eslint.config.js`, which is exactly the kind of
 * configuration that survives a refactor in form and not in effect — an `ignores` entry widened by
 * one glob, a `files` pattern that stops matching, and the boundary is gone with lint still green.
 * So this runs the real ESLint — over temporary files at real paths, and over `routes/ask.ts`
 * itself — and asserts which ones are refused. It is the difference between "the rule is written
 * down" and "the rule fires".
 *
 * Slower than a normal unit test — it loads the flat config — and worth it exactly once.
 */
import { ESLint } from 'eslint'
import { existsSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

const RULES = new Set(['no-restricted-imports', '@typescript-eslint/no-restricted-imports'])

/** Only the two restricted-import rules; an unused import here is not this test's business. */
function restrictedIn(messages: ESLint.LintResult['messages'], where: string): string[] {
  const parseError = messages.find((message) => message.ruleId === null)
  if (parseError !== undefined) {
    // Without this the "allowed" assertions pass for the wrong reason: `projectService: true`
    // refuses a path that does not exist, and a parse error carries no rule messages at all.
    throw new Error(`ESLint could not parse ${where}: ${parseError.message}`)
  }
  return messages
    .filter((message) => message.ruleId !== null && RULES.has(message.ruleId))
    .map((message) => message.message)
}

/**
 * Lints a **temporary** file at a path inside the tree, then deletes it.
 *
 * The file has to exist on disk because the type-aware config uses `projectService: true`. The
 * refusal to overwrite is not defensive noise: the first version of this test lint-checked
 * `routes/ask.ts` this way and **deleted the real route**, which every other test then failed to
 * import. A helper that writes files must be unable to write over one that matters.
 */
async function probe(relativePath: string, code: string): Promise<string[]> {
  const file = fileURLToPath(new URL(relativePath, `file://${ROOT}`))
  if (existsSync(file)) {
    throw new Error(`${relativePath} already exists; a probe must never overwrite a real file.`)
  }
  await writeFile(file, code, 'utf8')
  try {
    const [result] = await new ESLint({ cwd: ROOT }).lintText(code, {
      filePath: file,
      warnIgnored: false,
    })
    return restrictedIn(result?.messages ?? [], relativePath)
  } finally {
    await rm(file, { force: true })
  }
}

/** Lints a file that already exists, exactly as it ships. Nothing is written. */
async function lintExisting(relativePath: string): Promise<string[]> {
  const file = fileURLToPath(new URL(relativePath, `file://${ROOT}`))
  const [result] = await new ESLint({ cwd: ROOT }).lintFiles([file])
  return restrictedIn(result?.messages ?? [], relativePath)
}

const IMPORTS_CLIENT = "import { LlmClient } from '../llm/client.ts'\nexport const x = LlmClient\n"

describe('ADR-071 — no LLM calls in business logic', () => {
  it('refuses a route that is not on the list', async () => {
    const messages = await probe('apps/api/src/routes/__adr071_probe.ts', IMPORTS_CLIENT)
    expect(messages.join(' ')).toContain('ADR-071')
  })

  it('refuses `packages/db`, so the write path and the compiler cannot reach a model', async () => {
    const messages = await probe(
      'packages/db/src/__adr071_probe.ts',
      "import { LlmClient } from '../../../apps/api/src/llm/client.ts'\nexport const x = LlmClient\n",
    )
    expect(messages.join(' ')).toContain('ADR-071')
  })

  it('refuses `packages/core`, which is what keeps duplicate matching testable with no network', async () => {
    const messages = await probe(
      'packages/core/src/__adr071_probe.ts',
      "import { LlmClient } from '../../../apps/api/src/llm/client.ts'\nexport const x = LlmClient\n",
    )
    expect(messages.join(' ')).toContain('ADR-071')
  })

  /**
   * The other half, and the half that would fail silently: a rule that refuses everything is not a
   * boundary, it is an outage. `ask.ts` is one of the paths ADR-071 lists by name.
   */
  it('allows `routes/ask.ts`, which is on the list by exact path', async () => {
    // The real file, as it ships and as it actually imports the module — not a probe. A rule that
    // refuses everything is not a boundary, it is an outage.
    expect(await lintExisting('apps/api/src/routes/ask.ts')).toEqual([])
  })

  it('allows the module to import itself', async () => {
    expect(
      await probe(
        'apps/api/src/llm/__adr071_probe.ts',
        "import { LlmClient } from './client.ts'\nexport const x = LlmClient\n",
      ),
    ).toEqual([])
  })

  /**
   * `context.ts` has to name the client's type to declare the slot on `AppContext`, and a type
   * import compiles to nothing — it cannot call a model. `allowTypeImports` is the exemption, and
   * this is the assertion that says it is deliberate.
   */
  it('allows a type-only import from outside the zone', async () => {
    expect(
      await probe(
        'apps/api/src/__adr071_probe.ts',
        "import type { LlmClient } from './llm/client.ts'\nexport type X = LlmClient\n",
      ),
    ).toEqual([])
  })
})
