/**
 * Zod → the JSON Schema a `strict: true` structured output needs, and the walker that proves it
 * (ADR-066).
 *
 * The walker is the interesting half, and it is written the way it is because the obvious version
 * was wrong. Guarding with `if (node.type === 'object')` skips exactly the shape the house rules
 * mandate: `.nullable()` emits `anyOf: [{…the object…}, { type: 'null' }]`, so the object is one
 * level down and has no `type` on the wrapper at all. Four objects in a prompt schema can therefore
 * be missing `additionalProperties: false` while the check reports success.
 *
 * So: **key on the presence of a `properties` key**, and recurse explicitly through `anyOf`,
 * `oneOf`, `allOf` and `items`. `json-schema.test.ts` feeds `z.object({a: z.string()}).nullable()`
 * through and asserts the walker visits the inner object — it tests the test.
 */
import { z } from 'zod'

export type JsonSchemaNode = Record<string, unknown>

function isNode(value: unknown): value is JsonSchemaNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Every schema node reachable from the root, in document order, each with the dotted path that
 * reaches it. A node is anything that could be a subschema, not only the objects.
 */
export function walkJsonSchema(
  root: JsonSchemaNode,
  visit: (node: JsonSchemaNode, path: string) => void,
): void {
  const seen = new Set<JsonSchemaNode>()

  const recurse = (node: unknown, path: string): void => {
    if (!isNode(node) || seen.has(node)) return
    seen.add(node)
    visit(node, path)

    for (const key of ['anyOf', 'oneOf', 'allOf', 'prefixItems'] as const) {
      const branch = node[key]
      if (Array.isArray(branch)) {
        branch.forEach((child, index) => recurse(child, `${path}.${key}[${String(index)}]`))
      }
    }

    // `items` is a single subschema in 2020-12; a boolean or an array is not a place to recurse.
    recurse(node.items, `${path}.items`)

    const properties = node.properties
    if (isNode(properties)) {
      for (const [name, child] of Object.entries(properties)) {
        recurse(child, path === '' ? name : `${path}.${name}`)
      }
    }
  }

  recurse(root, '')
}

/**
 * Every way a schema would be refused by a strict structured output, or would silently let a field
 * through unvalidated. Returns the empty array when there is nothing wrong.
 */
export function strictSchemaViolations(root: JsonSchemaNode): string[] {
  const problems: string[] = []

  walkJsonSchema(root, (node, path) => {
    const properties = node.properties
    if (!isNode(properties)) return
    const where = path === '' ? '(root)' : path

    if (node.additionalProperties !== false) {
      problems.push(`${where}: needs additionalProperties: false`)
    }

    const declared = Object.keys(properties)
    const required = Array.isArray(node.required) ? node.required.map(String) : []
    const missing = declared.filter((name) => !required.includes(name))
    if (missing.length > 0) {
      // Not a style rule: a strict structured output refuses a schema whose `required` does not
      // name every property, and the failure arrives as a provider 400 rather than as anything
      // pointing here. Use `.nullable()`, never `.optional()`.
      problems.push(`${where}: every property must be required, missing ${missing.join(', ')}`)
    }
  })

  return problems
}

export class StrictSchemaError extends Error {
  override readonly name = 'StrictSchemaError'
  readonly violations: readonly string[]

  constructor(schemaName: string, violations: readonly string[]) {
    super(`The JSON schema for "${schemaName}" is not strict:\n  ${violations.join('\n  ')}`)
    this.violations = violations
  }
}

/**
 * The JSON Schema for one prompt's output.
 *
 * `$schema` is stripped: it is metadata about the dialect rather than a constraint, and a provider
 * that validates the schema object itself has one more key to object to for no benefit.
 *
 * This throws rather than returning a `Result`, because a non-strict prompt schema is a programmer
 * error caught at module load and in CI (ADR-034) — never something a request can cause.
 */
export function toStrictJsonSchema(schema: z.ZodType, schemaName: string): JsonSchemaNode {
  const emitted = z.toJSONSchema(schema, { target: 'draft-2020-12' }) as JsonSchemaNode
  const { $schema: _dialect, ...rest } = emitted
  const violations = strictSchemaViolations(rest)
  if (violations.length > 0) throw new StrictSchemaError(schemaName, violations)
  return rest
}
