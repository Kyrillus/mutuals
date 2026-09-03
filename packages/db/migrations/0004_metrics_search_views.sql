-- The materialised derived columns, the search document, and saved views.

-- A separate 1:1 table rather than columns on contact, so the nightly warmth sweep rewrites a
-- ~48-byte row instead of the contact row and keeps contact's heap dense.
CREATE TABLE contact_metrics (
  contact_id            uuid PRIMARY KEY REFERENCES contact(id) ON DELETE CASCADE,
  workspace_id          uuid REFERENCES workspace(id) ON DELETE CASCADE,
  last_interaction_at   timestamptz,
  interaction_count_12m integer  NOT NULL DEFAULT 0,
  open_followups        integer  NOT NULL DEFAULT 0,
  next_followup_at      date,
  warmth                smallint NOT NULL DEFAULT 0 CHECK (warmth BETWEEN 0 AND 100),
  computed_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cm_last_idx  ON contact_metrics (last_interaction_at DESC NULLS LAST, contact_id);
CREATE INDEX cm_warm_idx  ON contact_metrics (warmth DESC, contact_id);
CREATE INDEX cm_count_idx ON contact_metrics (interaction_count_12m DESC, contact_id);
CREATE INDEX cm_open_idx  ON contact_metrics (open_followups DESC, contact_id) WHERE open_followups > 0;
CREATE INDEX cm_next_idx  ON contact_metrics (next_followup_at) WHERE next_followup_at IS NOT NULL;

CREATE TABLE organization_metrics (
  organization_id     uuid PRIMARY KEY REFERENCES organization(id) ON DELETE CASCADE,
  workspace_id        uuid REFERENCES workspace(id) ON DELETE CASCADE,
  people_count        integer NOT NULL DEFAULT 0,
  last_interaction_at timestamptz,
  computed_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX om_people_idx ON organization_metrics (people_count DESC, organization_id);
CREATE INDEX om_last_idx   ON organization_metrics (last_interaction_at DESC NULLS LAST, organization_id);

CREATE TABLE search_document (
  record_id    uuid PRIMARY KEY REFERENCES record(id) ON DELETE CASCADE,
  workspace_id uuid REFERENCES workspace(id) ON DELETE CASCADE,
  object_type  object_type NOT NULL,
  title        text NOT NULL DEFAULT '',
  body         text NOT NULL DEFAULT '',
  -- The two-argument to_tsvector is mandatory: the one-argument form reads a GUC and is only
  -- STABLE, so it cannot appear in a generated column. 'simple' rather than 'english' because this
  -- is a multilingual address book of proper nouns, which English stemming mangles.
  tsv          tsvector GENERATED ALWAYS AS (
                 setweight(to_tsvector('simple', coalesce(title,'')), 'A') ||
                 setweight(to_tsvector('simple', coalesce(body,'')),  'B')) STORED,
  -- Present from Stage 1 so the search API's `mode` parameter has somewhere to point; always NULL
  -- until the backfill. A vector(1536) is ~6 kB, which is why it lives here and not on contact.
  embedding    vector(1536),
  embedding_model text,
  embedded_at  timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sd_tsv_idx        ON search_document USING gin (tsv);
CREATE INDEX sd_title_trgm_idx ON search_document USING gin ((lower(title)) gin_trgm_ops);
-- The HNSW index is created in a later stage, AFTER the first embedding backfill, so it is never
-- built on an empty column:
--   CREATE INDEX sd_hnsw_idx ON search_document USING hnsw (embedding vector_cosine_ops)
--     WITH (m = 16, ef_construction = 64);
-- pgvector indexes cap at 2000 dimensions for `vector` and 4000 for `halfvec`; 1536 fits.

CREATE TABLE saved_view (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspace(id) ON DELETE CASCADE,
  object_type  object_type NOT NULL,
  name         text NOT NULL,
  is_default   boolean NOT NULL DEFAULT false,
  columns      jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{slug, width?}] in display order
  filters      jsonb NOT NULL DEFAULT '[]'::jsonb,   -- the serialised filter model
  sort         jsonb,                                -- {slug, direction}
  position     integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sv_name_uq UNIQUE NULLS NOT DISTINCT (workspace_id, object_type, name)
);
CREATE UNIQUE INDEX sv_default_uq ON saved_view (workspace_id, object_type)
  NULLS NOT DISTINCT WHERE is_default;
