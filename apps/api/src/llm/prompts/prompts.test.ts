/**
 * ADR-072's layer 1: a golden JSON-schema snapshot per prompt, and no network anywhere near it.
 *
 * The snapshot is not decoration. `z.toJSONSchema` decides how `.nullable()` is emitted, and a zod
 * minor that changes it turns a working prompt into a provider 400 in production. As a snapshot it
 * is a diff in a pull request instead.
 */
import { describe, expect, it } from 'vitest'

import { strictSchemaViolations } from '../json-schema.ts'
import { PLANNED_PROMPTS, PROMPTS, promptById } from './index.ts'
import { askFilterPrompt } from './ask-filter.ts'
import { outputJsonSchema, registered, schemaNameOf } from './spec.ts'

describe('the prompt registry', () => {
  it('has a unique id and a positive version for every prompt', () => {
    const ids = PROMPTS.map((prompt) => prompt.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const prompt of PROMPTS) expect(prompt.version).toBeGreaterThan(0)
  })

  /** The same guard `PLANNED_OPERATIONS` gets: a planned name cannot quietly become a second id. */
  it('is disjoint from the prompts the second half will add', () => {
    const registeredIds = new Set(PROMPTS.map((prompt) => prompt.id))
    expect(PLANNED_PROMPTS.filter((id) => registeredIds.has(id))).toEqual([])
  })

  it('finds a prompt by id and answers undefined for one that does not exist', () => {
    expect(promptById('ask.filter')?.version).toBe(1)
    expect(promptById('nonesuch')).toBeUndefined()
  })

  it('emits a strict schema for every prompt, so no provider can refuse one', () => {
    for (const prompt of PROMPTS) {
      expect(
        strictSchemaViolations(outputJsonSchema(prompt)),
        `${prompt.id} v${String(prompt.version)}`,
      ).toEqual([])
    }
  })

  it('names the schema stably and identifiably', () => {
    expect(schemaNameOf(askFilterPrompt)).toBe('ask_filter_v1')
  })
})

describe('ask.filter', () => {
  it('renders its own sample, so the lock hashes something type-checked', () => {
    const messages = registered(askFilterPrompt).renderSample()
    expect(messages).toHaveLength(2)
    expect(messages[0]?.role).toBe('system')
    expect(messages[1]?.content).toContain('Which investors in Munich')
    // ADR-034: today is in the prompt because it is injected, never read from the wall clock.
    expect(messages[1]?.content).toContain('2026-06-15')
  })

  it('puts every field slug and every option key in front of the model', () => {
    const user = registered(askFilterPrompt).renderSample()[1]?.content ?? ''
    expect(user).toContain('job_role')
    expect(user).toContain('investor=Investor')
    expect(user).toContain('last_interaction_at')
  })

  it('carries the repair complaints when there are any, and says nothing when there are none', () => {
    const clean = askFilterPrompt.render(askFilterPrompt.sample)[1]?.content ?? ''
    expect(clean).not.toContain('rejected')

    const repaired =
      askFilterPrompt.render({
        ...askFilterPrompt.sample,
        problems: ['"nonesuch" is not a field.'],
      })[1]?.content ?? ''
    expect(repaired).toContain('was rejected')
    expect(repaired).toContain('"nonesuch" is not a field.')
  })

  /**
   * The property ADR-067 says falls out of the type: the output has no attribute-id field and no
   * record-id field, so "the LLM extracts, code decides" cannot be violated by a wording change.
   */
  it('has no way to name an attribute id or a record id', () => {
    const schema = outputJsonSchema(askFilterPrompt)
    const json = JSON.stringify(schema)
    expect(json).not.toContain('attributeId')
    expect(json).not.toContain('recordId')
    expect(json).not.toContain('uuid')
  })

  it('matches its golden JSON schema', () => {
    expect(outputJsonSchema(askFilterPrompt)).toMatchSnapshot()
  })
})
