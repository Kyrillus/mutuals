-- Four foreign keys had no index behind the referencing column, so every ON DELETE CASCADE and
-- ON DELETE SET NULL had to sequentially scan a large table to find the rows it was about to touch.
-- Postgres indexes the *referenced* side automatically (it is a primary key) but never the
-- referencing side, which is easy to miss precisely because nothing complains until there is data.
--
-- Measured by `pnpm db:check` at 10,000 contacts x 60 attributes, before this migration:
-- deleting ONE contact took 4.0 s, and bulk deletion was quadratic. The performance harness had to
-- create these same four indexes temporarily just to be able to clean up after itself, which is how
-- the gap was found.
--
-- Two of the four are partial. `superseded_by_id` and `target_record_id` are NULL on the large
-- majority of fact rows -- a fact is only superseded once something replaces it, and only relation
-- facts point at another record -- so the partial index is a fraction of the size of a full one and
-- serves the cascade equally well: the cascade is looking for non-NULL referrers by definition.

CREATE INDEX fact_superseded_idx ON fact (superseded_by_id) WHERE superseded_by_id IS NOT NULL;
CREATE INDEX fact_target_idx ON fact (target_record_id) WHERE target_record_id IS NOT NULL;
CREATE INDEX av_fact_idx ON attribute_value (fact_id);
CREATE INDEX rl_fact_idx ON record_link (fact_id);

-- A fifth case the record-deletion measurement could not see. `fact_shape_fk` references
-- attribute_definition, and every index on `fact` leads with `record_id`, so deleting an ATTRIBUTE
-- definition -- §6.7's delete flow, behind a dialog that promises to state how many records are
-- affected -- sequentially scans the whole fact log. attribute_value is already covered, because
-- ADR-013 leads all nine of its indexes with attribute_id; only fact was missing.
CREATE INDEX fact_attribute_idx ON fact (attribute_id);

COMMENT ON INDEX fact_superseded_idx IS
  'Backs the self-referencing FK''s ON DELETE SET NULL. Without it, deleting a record seq-scans fact.';
COMMENT ON INDEX fact_target_idx IS
  'Backs the relation FK''s ON DELETE CASCADE. Without it, deleting a record seq-scans fact.';
COMMENT ON INDEX av_fact_idx IS
  'Backs attribute_value.fact_id''s ON DELETE CASCADE.';
COMMENT ON INDEX rl_fact_idx IS
  'Backs record_link.fact_id''s ON DELETE CASCADE.';
