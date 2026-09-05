-- The duplicate probe asks `identifier` one question -- "does anybody already own this handle?" --
-- and until now no index could answer it. `identifier_uq` is (workspace_id, kind, value) and the
-- probe is deliberately workspace-agnostic (it narrows through `record.object_type` instead), so
-- its leading column is unbound and the index is unusable. `identifier_record_idx` leads with
-- record_id, which the probe does not know: finding the record is the whole point.
--
-- What filled the gap was migration 0011's `identifier_value_trgm_idx`, added for the palette's
-- substring search -- and a GIN trigram index will serve `value = $1`, badly. Measured at 10,760
-- records with 16,000 pairs to look up, which is one 10,000-row LinkedIn export:
--
--     with only identifier_value_trgm_idx   4,148 ms, 1,052,275 shared buffer hits
--     with this index                         110 ms,    48,000 shared buffer hits
--
-- So this is the Stage-1 finding F1 in a new place: a foreign-key-shaped lookup with no index
-- behind it, hidden because a *different* index was willing to answer slowly rather than not at
-- all. It is (kind, value) rather than (value) because kind is part of the identity claim -- an
-- email and a LinkedIn slug are allowed to be the same string and mean different people.
--
-- It overlaps `identifier_uq` by two of three columns and is worth the duplication: one row per
-- handle per record makes this the smallest large table in the schema (13 MB at 22,509 rows), and
-- the alternative is passing a workspace into a probe that has never needed one.

CREATE INDEX identifier_kind_value_idx ON identifier (kind, value);

COMMENT ON INDEX identifier_kind_value_idx IS
  'Backs the import wizard''s bulk duplicate probe. Without it the planner answers value = $1 from the trigram GIN, at 38x the cost.';
