-- The import batch, its per-row staging table, and the deferred foreign key from record.

CREATE TABLE import_batch (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspace(id) ON DELETE CASCADE,
  file_name    text        NOT NULL,
  object_type  object_type NOT NULL,
  row_count    integer     NOT NULL DEFAULT 0,
  mapping      jsonb       NOT NULL DEFAULT '{}'::jsonb,   -- opaque config, never filtered on

  -- The state machine the wizard polls and the Resume button reads. It replaces the deleted
  -- import.failed dead-letter queue: the import handler's catch writes 'failed' plus the error
  -- detail here, in its own committed transaction, and a resume restarts at
  -- last_committed_row + 1.
  status            text NOT NULL DEFAULT 'parsing'
                      CHECK (status IN ('parsing','mapping','reviewing','importing','completed','failed')),
  last_committed_row integer NOT NULL DEFAULT 0,
  error_detail       jsonb,

  created_count  integer NOT NULL DEFAULT 0,
  merged_count   integer NOT NULL DEFAULT 0,
  skipped_count  integer NOT NULL DEFAULT 0,
  imported_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX import_batch_recent_idx ON import_batch (imported_at DESC, id);

-- The record column exists from 0002 because record is created first; the constraint lands here,
-- where its target finally exists. The whole migration run is one transaction, so no database ever
-- observes the column without the constraint.
ALTER TABLE record
  ADD CONSTRAINT record_import_batch_fk FOREIGN KEY (import_batch_id)
  REFERENCES import_batch(id) ON DELETE SET NULL;

-- Per-row staging for the Review grid: parsed values, the mapped values, validation errors and the
-- user's per-row duplicate decision. It is scratch space for one batch, so it hangs off
-- import_batch and carries no workspace_id of its own.
CREATE TABLE import_row (
  batch_id     uuid NOT NULL REFERENCES import_batch(id) ON DELETE CASCADE,
  row_number   integer NOT NULL,
  raw          jsonb NOT NULL,                        -- the source row, verbatim
  mapped       jsonb NOT NULL DEFAULT '{}'::jsonb,    -- slug -> canonical value, after edits
  errors       jsonb NOT NULL DEFAULT '[]'::jsonb,    -- [] means the row is importable
  duplicate_of uuid REFERENCES record(id) ON DELETE SET NULL,
  decision     text CHECK (decision IN ('skip','merge','create')),
  PRIMARY KEY (batch_id, row_number)
);
-- The Review grid's "Error rows (n)" tab, and the skipped-row error report.
CREATE INDEX import_row_error_idx ON import_row (batch_id, row_number)
  WHERE errors <> '[]'::jsonb;
-- The duplicate chips, and the bulk "apply this decision to all duplicates" action.
CREATE INDEX import_row_duplicate_idx ON import_row (batch_id, row_number)
  WHERE duplicate_of IS NOT NULL;
