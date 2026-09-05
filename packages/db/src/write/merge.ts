/**
 * §6.9's merge: two records become one, and nothing is thrown away.
 *
 * **The loser's facts are moved, not deleted.** That is the whole design, and it follows from §4.5
 * rather than from taste: `fact` is the append-only truth and `attribute_value` is only its
 * projection, so a merge that wrote fresh values on the survivor and deleted the other record would
 * destroy every observation ever made about a person who — by the user's own assertion — is the
 * same person. Moving them means the survivor's history popover shows
 * "Company: Stripe — since Jun 2025, from LinkedIn import" even though that was observed against
 * the record that no longer exists. That is truthful; they were always one person.
 *
 * The database does most of the correctness work, and that is deliberate:
 *
 *   - `fact_live_uq` — unique `(record_id, attribute_id, value_key)` where `superseded_by_id IS
 *     NULL` — makes it *impossible* to end up with two live values for one field. Every conflict
 *     has to be resolved by superseding one side before the move, so a merge cannot silently
 *     produce a record with two emails.
 *   - It constrains **live** rows only, which is what lets superseded history move freely.
 *   - `rl_no_self` and `rl_uq` catch a link that would point at itself or duplicate another.
 *
 * So the order below is not arbitrary. Supersede first, then move.
 */
import type { CivilDate, ObjectType, Uuid } from '@mutuals/core'
import { sql } from 'kysely'

import { recomputeMetrics } from '../seed/metrics.ts'
import { WriteError, type Executor, type Provenance } from './types.ts'

export interface MergeInput {
  /** The record that stays. Its id is the one every link and follow-up ends up pointing at. */
  readonly survivorId: Uuid
  /** The record that is absorbed and then deleted. */
  readonly loserId: Uuid
  /**
   * Which side wins each contested field, by attribute id. Anything not named keeps the survivor's
   * value, which is the safe default: a merge the user did not think about does not change what
   * they were already looking at.
   */
  readonly choices?: Readonly<Record<string, 'survivor' | 'loser'>>
  /** Recorded on the tombstoning supersede, so the history says a merge did this. */
  readonly provenance?: Provenance
  /**
   * The civil day and zone warmth is recomputed against, or absent to leave it stale.
   *
   * Injected rather than read here, for ADR-034's reason one layer down: `now` is a parameter
   * everywhere in this codebase, and a merge that took the wall clock would make its own tests
   * depend on what day the machine thinks it is. The survivor inherits the loser's interactions, so
   * its warmth really has moved — the caller is expected to pass this.
   */
  readonly metrics?: { readonly today: CivilDate; readonly timeZone?: string }
}

export interface MergeResult {
  readonly survivorId: Uuid
  readonly factsMoved: number
  readonly linksRepointed: number
  readonly followUpsMoved: number
  readonly interactionsMoved: number
  readonly identifiersMoved: number
  /** Fields where both records had a value and one had to give way. */
  readonly conflictsResolved: number
}

interface RecordRow {
  id: string
  object_type: ObjectType
  workspace_id: string | null
}

export async function mergeRecords(exec: Executor, input: MergeInput): Promise<MergeResult> {
  if (input.survivorId === input.loserId) {
    throw new WriteError('A record cannot be merged into itself')
  }

  const run = async (trx: Executor): Promise<MergeResult> => {
    const [survivor, loser] = await requirePair(trx, input.survivorId, input.loserId)
    if (survivor.object_type !== loser.object_type) {
      throw new WriteError(
        `Cannot merge a ${loser.object_type} into a ${survivor.object_type}: they are different kinds of record`,
      )
    }

    const choices = input.choices ?? {}

    // ---- 1. resolve the fields both records have a live value for --------------------------------
    //
    // A conflict is a `(attribute_id, value_key)` that is live on both. For a single-valued
    // attribute the key is always `''`, so that is "both have an email". For a multi-valued one the
    // key is the element, so two records tagged `intros` conflict on that tag and merge silently on
    // every tag only one of them has — which is the right behaviour for a set.
    const conflicts = await trx
      .selectFrom('fact as mine')
      .innerJoin('fact as theirs', (join) =>
        join
          .onRef('theirs.attribute_id', '=', 'mine.attribute_id')
          .onRef('theirs.value_key', '=', 'mine.value_key')
          .on('theirs.record_id', '=', input.loserId)
          .on('theirs.superseded_by_id', 'is', null)
          .on('theirs.removed_at', 'is', null),
      )
      .select(['mine.id as survivor_fact', 'theirs.id as loser_fact', 'mine.attribute_id'])
      .where('mine.record_id', '=', input.survivorId)
      .where('mine.superseded_by_id', 'is', null)
      .where('mine.removed_at', 'is', null)
      .execute()

    for (const conflict of conflicts) {
      const keepLoser = choices[conflict.attribute_id] === 'loser'
      const superseded = keepLoser ? conflict.survivor_fact : conflict.loser_fact
      const winner = keepLoser ? conflict.loser_fact : conflict.survivor_fact
      await supersedeFact(trx, superseded, winner)
    }

    // ---- 2. links that would become self-links ---------------------------------------------------
    //
    // If the survivor was linked to the loser — two contacts marked as each other's mentor, an
    // organization linked to the one it is absorbing — repointing would produce a link from a record
    // to itself, which `rl_no_self` refuses. Superseding is right rather than a workaround: after
    // the merge the relationship genuinely no longer exists, because the two ends are one record.
    const selfLinks = await trx
      .selectFrom('fact')
      .select('id')
      .where('superseded_by_id', 'is', null)
      .where((eb) =>
        eb.or([
          eb.and([
            eb('record_id', '=', input.survivorId),
            eb('target_record_id', '=', input.loserId),
          ]),
          eb.and([
            eb('record_id', '=', input.loserId),
            eb('target_record_id', '=', input.survivorId),
          ]),
        ]),
      )
      .execute()
    for (const link of selfLinks) await supersedeFact(trx, link.id, null)

    // ---- 3. incoming links that would duplicate ---------------------------------------------------
    //
    // A contact linked to *both* organizations would end up with two identical links, which `rl_uq`
    // refuses. The one pointing at the loser gives way — the survivor's is the record that stays, so
    // its link is the one whose id and metadata the user has been looking at.
    const incomingDuplicates = await trx
      .selectFrom('fact as to_loser')
      .innerJoin('fact as to_survivor', (join) =>
        join
          .onRef('to_survivor.record_id', '=', 'to_loser.record_id')
          .onRef('to_survivor.attribute_id', '=', 'to_loser.attribute_id')
          .on('to_survivor.target_record_id', '=', input.survivorId)
          .on('to_survivor.superseded_by_id', 'is', null),
      )
      .select(['to_loser.id as loser_fact', 'to_survivor.id as survivor_fact'])
      .where('to_loser.target_record_id', '=', input.loserId)
      .where('to_loser.superseded_by_id', 'is', null)
      .where('to_loser.record_id', '!=', input.loserId)
      .execute()
    for (const duplicate of incomingDuplicates) {
      await supersedeFact(trx, duplicate.loser_fact, duplicate.survivor_fact)
    }

    // ---- 4. move the facts -------------------------------------------------------------------------
    //
    // Every one of them, live and superseded alike. `fact_live_uq` covers only live rows, so the
    // history moves without a fight — and if step 1 missed a conflict, this is where the database
    // says so rather than where a duplicate value quietly appears.
    const moved = await trx
      .updateTable('fact')
      .set({ record_id: input.survivorId })
      .where('record_id', '=', input.loserId)
      .executeTakeFirst()

    // ---- 5. repoint what pointed at the loser ------------------------------------------------------
    //
    // `value_key` moves with `target_record_id`, because for a multi-valued relation the key *is*
    // the target id (`value-key.ts`). Leaving it behind would make `fact_live_uq` and the projector
    // disagree about which slot a link occupies, which is the kind of divergence the
    // projection-equivalence gate finds a week later. `fact_single_key` requires the key to stay
    // empty for a single-valued attribute, hence the branch.
    const affected = await trx
      .selectFrom('fact')
      .select('record_id')
      .distinct()
      .where('target_record_id', '=', input.loserId)
      .where('record_id', '!=', input.survivorId)
      .execute()

    const repointed = await trx
      .updateTable('fact')
      .set({
        target_record_id: input.survivorId,
        value_key: sql<string>`case when is_multi then ${input.survivorId}::text else '' end`,
      })
      .where('target_record_id', '=', input.loserId)
      .executeTakeFirst()

    // ---- 6. everything that hangs off the subtype rather than off `record` --------------------------
    const identifiers = await moveIdentifiers(trx, input)
    const followUps =
      survivor.object_type === 'contact' ? await moveFollowUps(trx, input) : { count: 0 }
    const interactions = await moveInteractionLinks(trx, input, survivor.object_type)

    // A lingering import batch that flagged a row against the loser should point at the record that
    // still exists. Without this the pointer is nulled by the delete and the batch forgets why it
    // flagged the row.
    await trx
      .updateTable('import_row')
      .set({ duplicate_of: input.survivorId })
      .where('duplicate_of', '=', input.loserId)
      .execute()

    // ---- 7. the loser goes ---------------------------------------------------------------------------
    //
    // Its facts are already the survivor's, so the cascade takes only the husk: the subtype row, the
    // stale projection and the search document.
    await trx.deleteFrom('record').where('id', '=', input.loserId).execute()

    // ---- 8. rebuild what is derived -----------------------------------------------------------------
    const toReproject = [
      input.survivorId,
      ...affected.map((row) => row.record_id).filter((id) => id !== input.loserId),
    ]
    for (const id of new Set(toReproject)) {
      await sql`select project_record(${id})`.execute(trx)
    }
    await sql`update record set updated_at = now() where id = ${input.survivorId}`.execute(trx)

    if (survivor.object_type === 'contact' && input.metrics !== undefined) {
      await recomputeMetrics(trx, {
        today: input.metrics.today,
        ...(input.metrics.timeZone === undefined ? {} : { timeZone: input.metrics.timeZone }),
        scope: { contactIds: [input.survivorId] },
      })
    }

    return {
      survivorId: input.survivorId,
      factsMoved: Number(moved?.numUpdatedRows ?? 0n),
      linksRepointed: Number(repointed?.numUpdatedRows ?? 0n),
      followUpsMoved: followUps.count,
      interactionsMoved: interactions,
      identifiersMoved: identifiers,
      conflictsResolved: conflicts.length,
    }
  }

  return exec.isTransaction ? run(exec) : exec.transaction().execute(run)
}

async function requirePair(
  exec: Executor,
  survivorId: Uuid,
  loserId: Uuid,
): Promise<[RecordRow, RecordRow]> {
  const rows = await exec
    .selectFrom('record')
    .select(['id', 'object_type', 'workspace_id'])
    .where('id', 'in', [survivorId, loserId])
    // Locked in a stable order, so two merges naming the same pair from opposite directions cannot
    // deadlock against each other.
    .orderBy('id')
    .forUpdate()
    .execute()

  const survivor = rows.find((row) => row.id === survivorId)
  const loser = rows.find((row) => row.id === loserId)
  if (survivor === undefined) throw new WriteError(`No record ${survivorId}`)
  if (loser === undefined) throw new WriteError(`No record ${loserId}`)
  return [survivor, loser]
}

/**
 * Marks one fact as replaced by another.
 *
 * `superseded_by_id` may be `null` for a value that simply stops being true — a link that has become
 * a link to oneself has no successor, and inventing one would put a fact in the history that nothing
 * observed.
 */
async function supersedeFact(
  exec: Executor,
  factId: string,
  supersededBy: string | null,
): Promise<void> {
  await exec
    .updateTable('fact')
    .set({ superseded_by_id: supersededBy })
    .where('id', '=', factId)
    .execute()
}

/**
 * Moves the loser's identifiers, dropping the ones the survivor already has.
 *
 * `identifier_uq` is `(workspace_id, kind, value)`, so a shared email — very often the reason these
 * two records are being merged in the first place — would collide. Dropping the duplicate loses
 * nothing: the row it collides with says the same thing.
 */
async function moveIdentifiers(exec: Executor, input: MergeInput): Promise<number> {
  await sql`
    delete from identifier loser
     where loser.record_id = ${input.loserId}
       and exists (
             select 1 from identifier survivor
              where survivor.record_id = ${input.survivorId}
                and survivor.kind = loser.kind
                and survivor.value = loser.value)
  `.execute(exec)

  const moved = await exec
    .updateTable('identifier')
    .set({ record_id: input.survivorId })
    .where('record_id', '=', input.loserId)
    .executeTakeFirst()
  return Number(moved?.numUpdatedRows ?? 0n)
}

/** §6.9: "interactions and follow-ups are moved to the survivor". */
async function moveFollowUps(exec: Executor, input: MergeInput): Promise<{ count: number }> {
  const moved = await exec
    .updateTable('follow_up')
    .set({ contact_id: input.survivorId })
    .where('contact_id', '=', input.loserId)
    .executeTakeFirst()
  return { count: Number(moved?.numUpdatedRows ?? 0n) }
}

/**
 * Moves the loser's place on every interaction it attended.
 *
 * The join table's primary key is `(interaction_id, contact_id)`, so an interaction both records
 * attended already has the survivor on it — hence insert-then-delete rather than an update, which
 * would violate the key on exactly those rows.
 */
async function moveInteractionLinks(
  exec: Executor,
  input: MergeInput,
  objectType: ObjectType,
): Promise<number> {
  if (objectType === 'interaction') return 0

  const table = objectType === 'contact' ? 'interaction_contact' : 'interaction_organization'
  const column = objectType === 'contact' ? 'contact_id' : 'organization_id'

  const inserted = await sql<{ interaction_id: string }>`
    insert into ${sql.table(table)} (interaction_id, ${sql.id(column)})
    select interaction_id, ${input.survivorId} from ${sql.table(table)}
     where ${sql.id(column)} = ${input.loserId}
    on conflict do nothing
    returning interaction_id
  `.execute(exec)

  await sql`
    delete from ${sql.table(table)} where ${sql.id(column)} = ${input.loserId}
  `.execute(exec)

  return inserted.rows.length
}
