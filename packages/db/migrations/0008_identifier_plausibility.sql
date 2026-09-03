-- The projector wrote every email/phone/linkedin_url/website value into `identifier`, valid or not.
-- `identifier` is what duplicate detection probes, and ADR-042 scores a shared identifier of one of
-- those kinds at 0.95+. So two contacts whose email field says `n/a` -- or `-`, or `none`, or a
-- phone column holding `not available` -- became identifier twins scoring 0.97, landing in the
-- `certain` band, which is the band whose whole point is that it needs no human judgement.
--
-- Found by the integration suite, not by a person reading the SQL.
--
-- The fix is a plausibility predicate, not a validator. `packages/core` owns real validation and the
-- API rejects malformed input before it reaches a fact; this predicate exists for the paths that
-- bypass the API -- a raw psql write, the bulk COPY importer, a future MCP client -- and its only
-- job is to keep junk out of the one table that means "this handle identifies this person".
-- Deliberately permissive: a value it lets through is still validated wherever validation matters,
-- and a value it rejects is simply not treated as an identity claim. It does NOT re-implement
-- normalisation, which stays SQL-only and singular per ADR-019.

CREATE FUNCTION mutuals_identifier_plausible(p_kind text, p_value text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE
    -- Something before an @, something after it, and a dot in the domain.
    WHEN p_kind = 'email'        THEN p_value ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
    -- At least seven digits. Shorter is an extension, a typo or a placeholder, never a number that
    -- identifies a person. E.164 normalisation happens elsewhere and is not repeated here.
    WHEN p_kind = 'phone'        THEN length(regexp_replace(p_value, '[^0-9]', '', 'g')) >= 7
    -- A canonical LinkedIn handle, which is what the normaliser produces.
    WHEN p_kind = 'linkedin_url' THEN p_value ~ '^(in|company|school)/[a-z0-9%._-]{2,}$'
    -- A hostname with a dot and a plausible TLD.
    WHEN p_kind = 'website'      THEN p_value ~ '^[a-z0-9.-]+\.[a-z]{2,}(/.*)?$'
    ELSE true
  END
$fn$;

COMMENT ON FUNCTION mutuals_identifier_plausible(text, text) IS
  'Keeps placeholders out of the duplicate-detection table. Permissive by design: this is a guard on identity claims arriving from paths that bypass the API, not validation.';

-- 0003's projector, re-issued with the predicate added to step 3. plpgsql has no way to patch one
-- statement of an existing function, so the whole body is restated; the ONLY change from 0003 is the
-- extra AND in the identifier write-through.
CREATE OR REPLACE FUNCTION project_record(p_record uuid, p_attribute uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  ------------------------------------------------------------------ 1. attribute_value (non-relation)
  INSERT INTO attribute_value (
    workspace_id, object_type, record_id, attribute_id, value_kind, is_multi, value_key, position,
    fact_id, text_value, text_norm, text_sort, num_value, date_value, bool_value, option_id, updated_at)
  SELECT f.workspace_id, f.object_type, f.record_id, f.attribute_id, f.value_kind, f.is_multi,
         f.value_key,
         -- f.id is the final tiebreaker (ADR-024): every row of a COPY import shares one
         -- observed_at, so without it the ordering — and therefore `position` — is arbitrary.
         (row_number() OVER (PARTITION BY f.attribute_id
                             ORDER BY f.value_key, f.observed_at, f.id) - 1)::int,
         f.id,
         f.text_value,
         mutuals_norm(f.text_value),
         CASE WHEN d.type = 'long_text' THEN NULL
              ELSE left(mutuals_norm(f.text_value), 256) END,
         f.num_value, f.date_value, f.bool_value, f.option_id, now()
    FROM fact f
    JOIN attribute_definition d ON d.id = f.attribute_id
   WHERE f.record_id = p_record
     AND (p_attribute IS NULL OR f.attribute_id = p_attribute)
     AND f.superseded_by_id IS NULL
     AND f.removed_at IS NULL
     AND f.value_kind <> 'relation'
  ON CONFLICT (record_id, attribute_id, value_key) DO UPDATE SET
     fact_id = EXCLUDED.fact_id, position = EXCLUDED.position,
     text_value = EXCLUDED.text_value, text_norm = EXCLUDED.text_norm,
     text_sort = EXCLUDED.text_sort, num_value = EXCLUDED.num_value,
     date_value = EXCLUDED.date_value, bool_value = EXCLUDED.bool_value,
     option_id = EXCLUDED.option_id, updated_at = now();

  -- Upsert first, delete orphans second, as two separate statements: a DELETE and an ON CONFLICT
  -- INSERT in one statement share a snapshot and a command id and can raise
  -- "ON CONFLICT DO UPDATE command cannot affect row a second time".
  DELETE FROM attribute_value v
   WHERE v.record_id = p_record
     AND (p_attribute IS NULL OR v.attribute_id = p_attribute)
     AND NOT EXISTS (
           SELECT 1 FROM fact f
            WHERE f.record_id = v.record_id AND f.attribute_id = v.attribute_id
              AND f.value_key = v.value_key
              AND f.superseded_by_id IS NULL AND f.removed_at IS NULL);

  ------------------------------------------------------------------ 2. record_link (relations)
  INSERT INTO record_link (workspace_id, attribute_id, from_record_id, to_record_id,
                           title, valid_from, valid_to, is_primary, position, fact_id, updated_at)
  SELECT f.workspace_id, f.attribute_id, f.record_id, f.target_record_id,
         f.link_title, f.link_from, f.link_to, coalesce(f.link_is_primary, false),
         (row_number() OVER (PARTITION BY f.attribute_id
                             ORDER BY f.link_to NULLS FIRST, f.link_from DESC, f.id) - 1)::int,
         f.id, now()
    FROM fact f
   WHERE f.record_id = p_record
     AND (p_attribute IS NULL OR f.attribute_id = p_attribute)
     AND f.superseded_by_id IS NULL AND f.removed_at IS NULL
     AND f.value_kind = 'relation'
  ON CONFLICT (from_record_id, attribute_id, to_record_id) DO UPDATE SET
     title = EXCLUDED.title, valid_from = EXCLUDED.valid_from, valid_to = EXCLUDED.valid_to,
     is_primary = EXCLUDED.is_primary, position = EXCLUDED.position,
     fact_id = EXCLUDED.fact_id, updated_at = now();

  DELETE FROM record_link l
   WHERE l.from_record_id = p_record
     AND (p_attribute IS NULL OR l.attribute_id = p_attribute)
     AND NOT EXISTS (
           SELECT 1 FROM fact f
            WHERE f.record_id = l.from_record_id AND f.attribute_id = l.attribute_id
              AND f.target_record_id = l.to_record_id
              AND f.superseded_by_id IS NULL AND f.removed_at IS NULL);

  ------------------------------------------------------------------ 3. identifier write-through
  -- Duplicate detection is then a unique-index probe: deterministic, no LLM.
  INSERT INTO identifier (workspace_id, record_id, kind, value, source)
  SELECT v.workspace_id, v.record_id,
         CASE d.type WHEN 'email' THEN 'email' WHEN 'phone' THEN 'phone'
                     ELSE CASE WHEN d.slug = 'linkedin_url' THEN 'linkedin_url' ELSE 'website' END END,
         v.text_norm, f.source
    FROM attribute_value v
    JOIN attribute_definition d ON d.id = v.attribute_id
    JOIN fact f ON f.id = v.fact_id
   WHERE v.record_id = p_record
     AND (d.type IN ('email','phone') OR d.slug IN ('linkedin_url','website'))
     AND mutuals_identifier_plausible(
           (CASE d.type WHEN 'email' THEN 'email' WHEN 'phone' THEN 'phone'
                        ELSE CASE WHEN d.slug = 'linkedin_url' THEN 'linkedin_url'
                                  ELSE 'website' END END),
           v.text_norm)
  ON CONFLICT DO NOTHING;    -- identifiers accumulate: every handle ever seen is kept

  ------------------------------------------------------------------ 4. search_document
  -- Every string_agg is explicitly ordered (ADR-024). Without it the body — and therefore the
  -- generated tsvector — is not a function of the data, and db:reproject would produce a
  -- different-but-equally-valid string that fails the equivalence gate for no real reason.
  -- Each ORDER BY key is unique per record: (attribute_id, value_key) by av_record_attr_uq, and
  -- (attribute_id, to_record_id) by rl_uq.
  INSERT INTO search_document (record_id, workspace_id, object_type, title, body, updated_at)
  SELECT r.id, r.workspace_id, r.object_type, r.display_label,
         r.display_label || ' ' ||
         coalesce((SELECT i.body FROM interaction i WHERE i.id = r.id), '') || ' ' ||
         coalesce((SELECT string_agg(v.text_value, ' ' ORDER BY v.attribute_id, v.value_key)
                     FROM attribute_value v
                    WHERE v.record_id = r.id
                      AND v.value_kind = 'text'), '') || ' ' ||
         coalesce((SELECT string_agg(o.label, ' ' ORDER BY v.attribute_id, v.value_key)
                     FROM attribute_value v
                     JOIN attribute_option o ON o.id = v.option_id
                    WHERE v.record_id = r.id), '') || ' ' ||
         coalesce((SELECT string_agg(tr.display_label, ' ' ORDER BY l.attribute_id, l.to_record_id)
                     FROM record_link l
                     JOIN record tr ON tr.id = l.to_record_id
                    WHERE l.from_record_id = r.id), ''),
         now()
    FROM record r WHERE r.id = p_record
  ON CONFLICT (record_id) DO UPDATE SET
     title = EXCLUDED.title, body = EXCLUDED.body, updated_at = now();
END $$;
-- Values the previous behaviour already wrote. Left until now on purpose, so this runs after the
-- function it belongs to and a partially applied migration cannot leave the two out of step.
DELETE FROM identifier i WHERE NOT mutuals_identifier_plausible(i.kind, i.value);
