import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  StrictSchemaError,
  strictSchemaViolations,
  toStrictJsonSchema,
  walkJsonSchema,
  type JsonSchemaNode,
} from './json-schema.ts'

function visited(root: JsonSchemaNode): string[] {
  const paths: string[] = []
  walkJsonSchema(root, (_node, path) => paths.push(path))
  return paths
}

describe('the walker', () => {
  /**
   * ADR-066's bug, as a test. The previous walker guarded with `if (node.type === 'object')`, and
   * `.nullable()` emits `anyOf: [{…object…}, {type:'null'}]` — the wrapper has no `type` at all,
   * so the inner object was never visited and four objects in the quick-capture prompt were missing
   * `additionalProperties: false` while the check reported success.
   *
   * This test is the test of the test: it asserts the walker *reaches* the inner object, so a
   * regression to type-keying fails here rather than in production six weeks later.
   */
  it('descends into an object hidden inside a nullable, which has no `type` on its wrapper', () => {
    const schema = z.object({ inner: z.object({ a: z.string() }).nullable() })
    const emitted = z.toJSONSchema(schema, { target: 'draft-2020-12' }) as JsonSchemaNode

    const wrapper = (emitted.properties as Record<string, JsonSchemaNode | undefined>).inner
    expect(wrapper?.type, 'the shape this test exists for').toBeUndefined()
    expect(wrapper?.anyOf).toBeDefined()

    expect(visited(emitted)).toContain('inner.anyOf[0]')
  })

  it('descends through array items', () => {
    const schema = z.object({ rows: z.array(z.object({ a: z.string() })) })
    expect(visited(z.toJSONSchema(schema) as JsonSchemaNode)).toContain('rows.items')
  })

  it('visits a shared subschema once rather than looping forever', () => {
    const shared: JsonSchemaNode = { type: 'string' }
    const root: JsonSchemaNode = { properties: { a: shared, b: shared } }
    expect(visited(root)).toEqual(['', 'a'])
  })
})

describe('strictSchemaViolations', () => {
  it('accepts what zod emits for an all-required object', () => {
    const schema = z.object({ a: z.string(), b: z.object({ c: z.number() }).nullable() })
    expect(strictSchemaViolations(z.toJSONSchema(schema) as JsonSchemaNode)).toEqual([])
  })

  /**
   * `z.optional()` is dropped from `required` and zod emits no `required` key at all for an object
   * whose every property is optional — so "missing" has to be computed from the properties, not
   * from the presence of the array.
   */
  it('rejects an optional property, which a strict structured output refuses', () => {
    const schema = z.object({ a: z.string().optional() })
    expect(strictSchemaViolations(z.toJSONSchema(schema) as JsonSchemaNode)).toEqual([
      '(root): every property must be required, missing a',
    ])
  })

  it('rejects a nested object that would accept unknown keys', () => {
    const root: JsonSchemaNode = {
      properties: { inner: { properties: { a: { type: 'string' } }, required: ['a'] } },
      required: ['inner'],
      additionalProperties: false,
    }
    expect(strictSchemaViolations(root)).toEqual(['inner: needs additionalProperties: false'])
  })
})

describe('toStrictJsonSchema', () => {
  it('drops $schema, which is dialect metadata and not a constraint', () => {
    const emitted = toStrictJsonSchema(z.object({ a: z.string() }), 'probe')
    expect(emitted.$schema).toBeUndefined()
    expect(emitted.additionalProperties).toBe(false)
  })

  it('throws with every violation at once, because a prompt schema is fixed in one sitting', () => {
    let error: unknown
    try {
      toStrictJsonSchema(z.object({ a: z.string().optional(), b: z.number().optional() }), 'probe')
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(StrictSchemaError)
    expect((error as StrictSchemaError).violations).toHaveLength(1)
    expect((error as StrictSchemaError).message).toContain('probe')
  })
})
