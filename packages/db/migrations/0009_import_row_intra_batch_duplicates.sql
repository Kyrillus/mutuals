-- ADR-097. `import_row.duplicate_of` points at a `record`, which models exactly one kind of
-- duplicate: "this row matches a contact you already have". The other kind is invisible to it --
-- "this file lists this person twice" -- and it is the kind the LinkedIn fixture is full of, because
-- an export of your own connections contains the same person under two profiles far more often than
-- it contains someone you already had. At Review time the earlier row has not been committed and
-- has no record id, so it cannot be pointed at.
--
-- The two pointers are mutually exclusive rather than merged into one polymorphic column: the UI
-- has to word them differently, and a CHECK is cheaper than discovering later that half the rows
-- meant something else.

ALTER TABLE import_row
  ADD COLUMN duplicate_of_row integer,
  -- Why the band and the evidence are stored rather than recomputed: the Review grid is paged, and
  -- re-running the match for every page load is 10k probes per scroll. This is the same opaque-blob
  -- reasoning as `import_batch.mapping` -- read whole, written whole, never filtered on. What IS
  -- filtered on is "does this row have a duplicate at all", which the partial indexes below serve.
  ADD COLUMN duplicate_detail jsonb,
  ADD CONSTRAINT import_row_one_duplicate_kind
    CHECK (duplicate_of IS NULL OR duplicate_of_row IS NULL),
  ADD CONSTRAINT import_row_detail_needs_a_pointer
    CHECK (duplicate_detail IS NULL OR duplicate_of IS NOT NULL OR duplicate_of_row IS NOT NULL),
  -- A row cannot duplicate itself, and it may only point backwards. Forward pointers would let two
  -- rows name each other, and "collapse a chain to its first kept row" has no first row in a cycle.
  ADD CONSTRAINT import_row_duplicate_points_backwards
    CHECK (duplicate_of_row IS NULL OR duplicate_of_row < row_number),
  ADD CONSTRAINT import_row_duplicate_of_row_fk
    FOREIGN KEY (batch_id, duplicate_of_row) REFERENCES import_row (batch_id, row_number)
    -- The column list matters: a bare SET NULL would try to null `batch_id` too, which is NOT NULL.
    -- Rows are never deleted individually today; this keeps that from becoming a constraint error
    -- the day something does.
    ON DELETE SET NULL (duplicate_of_row);

-- 0005 indexed the record-pointer case. The row-pointer case needs its own, and the count the
-- Review header shows ("5 possible duplicates") reads both.
CREATE INDEX import_row_duplicate_row_idx ON import_row (batch_id, row_number)
  WHERE duplicate_of_row IS NOT NULL;

COMMENT ON COLUMN import_row.duplicate_of_row IS
  'Another row in the same batch that is the same entity. Always < row_number, so a chain has a first element. Mutually exclusive with duplicate_of.';
COMMENT ON COLUMN import_row.duplicate_detail IS
  'Why the match was made, for the chip: {band, confidence, rules, evidence, label}. Opaque, never filtered on.';
