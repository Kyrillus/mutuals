/**
 * §4.8's global search, behind §6.10's ⌘K palette.
 *
 * "Substring search across contact names, organization names, emails and interaction titles."
 * Three different questions, three different indexes, one merged answer — and the merge order is
 * the interesting part rather than an implementation detail.
 *
 * **An identifier beats a name beats a body.** Someone typing `anna@` is naming a person exactly;
 * someone typing `anna` is naming them approximately; someone whose meeting note happens to contain
 * "anna" is not naming them at all. So the three probes are ranked by *what kind of evidence they
 * are*, and only then by similarity within a kind. Ranking the merged set by one score would put a
 * strong trigram hit on a note above an exact email — which is the ordering a palette must not
 * have, because the palette is how you jump to a person you already have in mind.
 *
 * `mode` is not here. ADR-069 and §9 reserve it for the semantic variant, and it belongs at the API
 * where it can pick between this and an embedding query rather than inside a keyword search.
 */
import { sql } from 'kysely'

import type { ObjectType, Uuid } from '@mutuals/core'
import type { Executor } from '../write/types.ts'

/** Which index answered. The palette shows it, so a surprising result explains itself. */
export type SearchVia = 'label' | 'identifier' | 'text'

export interface SearchHit {
  readonly recordId: Uuid
  readonly objectType: ObjectType
  readonly displayName: string
  readonly via: SearchVia
  /** The matching email, or the sentence a full-text hit came from. `null` for a name match. */
  readonly snippet: string | null
  readonly rank: number
}

export interface SearchOptions {
  readonly q: string
  readonly limit: number
  readonly workspaceId: string | null
}

/**
 * `gin_trgm_ops` cannot extract a trigram from fewer than three characters, so a shorter needle
 * would fall back to a sequential scan on every keystroke. Two characters is also not a search —
 * it is most of the workspace — and the palette shows its own hint until the third key.
 */
export const MIN_SEARCH_LENGTH = 3

/**
 * One query, three branches, merged.
 *
 * `UNION ALL` then `DISTINCT ON (record_id)` rather than three round trips: the palette runs this
 * on every keystroke, and one query that the planner can bound is worth more than three that each
 * pay their own latency. `DISTINCT ON` with the ordering below keeps the *strongest* evidence for
 * a record and drops the rest, so a contact found by both email and name appears once, as an email
 * match.
 */
export async function searchRecords(
  exec: Executor,
  options: SearchOptions,
): Promise<readonly SearchHit[]> {
  const needle = options.q.trim()
  if (needle.length < MIN_SEARCH_LENGTH) return []

  const rows = await sql<{
    record_id: Uuid
    object_type: ObjectType
    display_label: string
    via: SearchVia
    snippet: string | null
    rank: number
  }>`
    with hits as (
      -- 1. The label, by trigram. sd_title_trgm_idx is on lower(title), so the needle is
      --    lower-cased on this side too; mutuals_norm is not used because that column is not
      --    the one indexed (ADR-019 constrains what TypeScript may normalise, not what SQL may).
      select r.id            as record_id,
             r.object_type   as object_type,
             r.display_label as display_label,
             r.workspace_id  as workspace_id,
             'label'::text   as via,
             null::text      as snippet,
             similarity(lower(sd.title), lower(${needle})) as rank
        from search_document sd
        join record r on r.id = sd.record_id
       where lower(sd.title) like '%' || lower(mutuals_esc(${needle})) || '%' escape '\\'

      union all

      -- 2. Identifiers. An email or a LinkedIn slug is an exact claim about who someone is, so it
      --    outranks everything; rank is 1 and the ordering below puts the kind first anyway.
      select r.id, r.object_type, r.display_label, r.workspace_id,
             'identifier'::text,
             i.value,
             1.0::real
        from identifier i
        join record r on r.id = i.record_id
       where i.value like '%' || lower(mutuals_esc(${needle})) || '%' escape '\\'

      union all

      -- 3. Full text over title and body — which is how an interaction whose *title* mentions
      --    someone is found, and the only branch that reaches a meeting note's contents.
      select r.id, r.object_type, r.display_label, r.workspace_id,
             'text'::text,
             ts_headline('simple', sd.body, websearch_to_tsquery('simple', ${needle}),
                         'MaxWords=14, MinWords=4, ShortWord=2, MaxFragments=1'),
             ts_rank(sd.tsv, websearch_to_tsquery('simple', ${needle}))
        from search_document sd
        join record r on r.id = sd.record_id
       where sd.tsv @@ websearch_to_tsquery('simple', ${needle})
    )
    select distinct on (record_id)
           record_id, object_type, display_label, via, snippet, rank::real as rank
      from hits
      -- The cast is load-bearing: an uncast parameter in an "is null" test leaves Postgres unable to
      -- determine its type, and the whole query fails at prepare time with a 500 rather than with
      -- anything that points here. Carried through the CTE rather than re-joining the record table.
     where ${options.workspaceId}::uuid is null
        or workspace_id = ${options.workspaceId}::uuid
     order by record_id,
              -- Within one record: the strongest kind of evidence wins the row.
              case via when 'identifier' then 0 when 'label' then 1 else 2 end,
              rank desc
  `.execute(exec)

  return rows.rows
    .map((row) => ({
      recordId: row.record_id,
      objectType: row.object_type,
      displayName: row.display_label,
      via: row.via,
      snippet: row.snippet === null || row.snippet.trim() === '' ? null : row.snippet,
      rank: Number(row.rank),
    }))
    .sort(compareHits)
    .slice(0, options.limit)
}

/**
 * The final ordering, in JavaScript rather than in SQL.
 *
 * `DISTINCT ON` dictates its own `ORDER BY` — it must lead with the distinct key — so the result
 * set comes back ordered by `record_id`, which is a uuid and therefore random. Re-sorting a bounded
 * set here is simpler and more honest than the subquery-wrapping needed to sort it in SQL, and the
 * set is bounded by how many records can match a three-character needle at all.
 */
function compareHits(a: SearchHit, b: SearchHit): number {
  const kind = viaOrder(a.via) - viaOrder(b.via)
  if (kind !== 0) return kind
  if (a.rank !== b.rank) return b.rank - a.rank
  return a.displayName.localeCompare(b.displayName)
}

function viaOrder(via: SearchVia): number {
  return via === 'identifier' ? 0 : via === 'label' ? 1 : 2
}
