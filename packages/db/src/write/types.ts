/**
 * The vocabulary the write path speaks: who is executing, what the attribute looks like, and where
 * a value came from.
 */
import type { Kysely, Transaction } from 'kysely'
import type { ObjectType, Uuid, ValueKind } from '@mutuals/core'
import type { AttributeType, DB, FactSource } from '../schema.ts'

/** A connection or an open transaction; every write helper accepts either. */
export type Executor = Kysely<DB> | Transaction<DB>

export type { FactSource }

/**
 * Where a value came from, carried on every fact row and on the tombstone that removes it.
 *
 * `validFrom` is stored and shown in the history popover but never orders currency (ADR-021);
 * omitting it means "as far as we know, today".
 */
export interface Provenance {
  readonly source: FactSource
  /** An import batch id, an interaction id, a message id — whatever explains `source`. */
  readonly sourceRef?: string | null
  /** `(0, 1]`. Defaults to the column default of 1.0. */
  readonly confidence?: number
  /** ISO calendar day; defaults to the database's `current_date`. */
  readonly validFrom?: string
}

/**
 * The columns of `attribute_definition` the write path needs, loaded once per call so no caller
 * has to pass a cardinality that could disagree with the row.
 */
export interface AttributeShape {
  readonly id: Uuid
  readonly objectType: ObjectType
  readonly type: AttributeType
  readonly slug: string
  readonly valueKind: ValueKind
  readonly isMulti: boolean
  readonly workspaceId: string | null
}

/** Thrown for a programmer error — an unknown attribute id, a value in the wrong slot. */
export class WriteError extends Error {
  override readonly name = 'WriteError'
}
