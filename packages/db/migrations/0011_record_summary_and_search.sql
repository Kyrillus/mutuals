-- Stage 6's second half: §6.5's cached summary, and the one index §4.8's search needs.

-- §6.5: "an LLM-generated 2-3 sentence summary ... generated on demand via a button and cached
-- with a timestamp, with a regenerate action".
--
-- A table rather than a read of the newest `llm_call` row, even though `llm_call_record_idx` makes
-- that a single indexed lookup. The trace is a trace: `LLM_TRACE_BODIES=off` nulls `parsed`, so
-- using it as the cache would make a privacy switch silently delete every summary in the product.
-- One row per record, replaced on regenerate -- history is not wanted here, because a summary is a
-- rendering of the facts rather than an observation about the world, and `fact` is where
-- observations live.
CREATE TABLE record_summary (
  record_id      uuid PRIMARY KEY REFERENCES record(id) ON DELETE CASCADE,
  workspace_id   uuid REFERENCES workspace(id) ON DELETE CASCADE,
  summary        text NOT NULL,
  -- What produced it, so a summary written by a model that has since been swapped is legible
  -- rather than mysterious. SET NULL, not CASCADE: pruning the trace must not delete the product.
  model          text NOT NULL,
  prompt_version integer NOT NULL,
  llm_call_id    uuid REFERENCES llm_call(id) ON DELETE SET NULL,
  generated_at   timestamptz NOT NULL DEFAULT now()
);

-- §4.8's global search: "substring search across contact names, organization names, emails and
-- interaction titles". Names and titles already have `sd_title_trgm_idx`; an email does not.
--
-- `identifier_uq` is a btree on (workspace_id, kind, value) and cannot serve `value ILIKE '%anna%'`
-- at all -- a leading wildcard is not a prefix. Without this index the palette's third probe is a
-- sequential scan of every identifier on every keystroke.
CREATE INDEX identifier_value_trgm_idx ON identifier USING gin (value gin_trgm_ops);
