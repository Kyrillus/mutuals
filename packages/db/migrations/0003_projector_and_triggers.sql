-- The label trigger, the projector, and the statement-level backstop that makes the projection
-- unbypassable.

-- The named owner of record.display_label / record.label_norm. It depends only on columns of the
-- row being written, so it is trivially correct and cannot drift.
-- The branches are separate statements rather than one CASE expression on purpose: plpgsql
-- compiles a whole expression against the row type it is running for, so a single
-- `CASE … NEW.display_name … NEW.name … NEW.title END` fails with `record "new" has no field
-- "name"` the first time a contact is written. Only the branch that executes is ever compiled.
CREATE FUNCTION sync_record_label() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE label text;
BEGIN
  IF TG_TABLE_NAME = 'contact' THEN
    label := NEW.display_name;
  ELSIF TG_TABLE_NAME = 'organization' THEN
    label := NEW.name;
  ELSE
    label := coalesce(NEW.title, '');
  END IF;

  UPDATE record
     SET display_label = label,
         label_norm    = mutuals_norm(label),
         updated_at    = now()
   WHERE id = NEW.id;
  RETURN NULL;
END $$;

CREATE TRIGGER contact_label      AFTER INSERT OR UPDATE ON contact
  FOR EACH ROW EXECUTE FUNCTION sync_record_label();
CREATE TRIGGER organization_label AFTER INSERT OR UPDATE ON organization
  FOR EACH ROW EXECUTE FUNCTION sync_record_label();
CREATE TRIGGER interaction_label  AFTER INSERT OR UPDATE ON interaction
  FOR EACH ROW EXECUTE FUNCTION sync_record_label();

-- The projector. It is SQL rather than TypeScript because it is mechanical column copying — the
-- type-specific branching that needs unit tests lives on the write side — and because being SQL is
-- what lets the trigger below make it unbypassable.
--
-- It references search_document, which migration 0004 creates. A plpgsql body is only
-- syntax-checked at CREATE FUNCTION time, so the forward reference resolves at first call, which
-- is after the whole migration run has committed.
CREATE FUNCTION project_record(p_record uuid, p_attribute uuid DEFAULT NULL)
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

-- The backstop. The application calls project_record() explicitly inside its own transaction with
-- the narrow (record, attribute) scope; this trigger exists so the invariant also survives a psql
-- session, a hand-run migration and the MCP server writing SQL directly. It is idempotent, so the
-- second run of a pair is a no-op upsert.
CREATE FUNCTION fact_project_trg() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r uuid;
BEGIN
  IF coalesce(current_setting('mutuals.defer_projection', true), 'off') = 'on' THEN
    RETURN NULL;
  END IF;
  FOR r IN SELECT DISTINCT record_id FROM changed LOOP
    PERFORM project_record(r, NULL);
  END LOOP;
  RETURN NULL;
END $$;

-- Statement-level with a transition table, not FOR EACH ROW, so a multi-row insert fires it once
-- instead of N times. Postgres refuses a transition table on a trigger with more than one event,
-- so this is three triggers over one function; `changed` is NEW for insert and update, OLD for
-- delete, and record_id is present in both.
CREATE TRIGGER fact_project_ins AFTER INSERT ON fact
  REFERENCING NEW TABLE AS changed
  FOR EACH STATEMENT EXECUTE FUNCTION fact_project_trg();
CREATE TRIGGER fact_project_upd AFTER UPDATE ON fact
  REFERENCING NEW TABLE AS changed
  FOR EACH STATEMENT EXECUTE FUNCTION fact_project_trg();
CREATE TRIGGER fact_project_del AFTER DELETE ON fact
  REFERENCING OLD TABLE AS changed
  FOR EACH STATEMENT EXECUTE FUNCTION fact_project_trg();
