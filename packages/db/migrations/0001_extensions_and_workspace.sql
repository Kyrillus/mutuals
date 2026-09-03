-- Extensions, the two SQL helper functions, the enum types, the workspace and the profile.

-- pgcrypto is deliberately absent (ADR-002): gen_random_uuid() has been core since Postgres 13,
-- so requiring the extension could only ever fail on an otherwise-fine cluster.
-- These four are load-bearing and CREATE EXTENSION aborts the whole migration run if one is
-- missing, which is the "fail loudly" the storage decision asks for. The documented fallbacks are
-- a single-column trigram GIN (no btree_gin) and dropping unaccent from mutuals_norm below.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS vector;

-- ADR-019: the ONE text normaliser. It is never used inside an index definition, so unaccent()
-- being STABLE rather than IMMUTABLE cannot matter, and no TypeScript twin needs to agree with it.
-- The dictionary is named explicitly because the one-argument form reads a GUC.
CREATE FUNCTION mutuals_norm(text) RETURNS text
  LANGUAGE sql STABLE STRICT AS $$ SELECT lower(unaccent('unaccent', btrim($1))) $$;

-- The needle of a `contains` filter is user input, so % and _ must not become wildcards.
-- Backslash is replaced first, otherwise the backslashes introduced by the later replaces would
-- themselves be escaped.
CREATE FUNCTION mutuals_esc(text) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT AS
  $$ SELECT replace(replace(replace($1, '\', '\\'), '%', '\%'), '_', '\_') $$;

CREATE TYPE object_type AS ENUM ('contact','organization','interaction');

CREATE TYPE attribute_type AS ENUM (
  'short_text','long_text','number','date','yes_no','single_select',
  'multi_select','tags','url','email','phone','relation');

-- Which physical slot an attribute_type lands in. Derived from attribute_type in code, stored so
-- the database can enforce it through the composite FK on fact and attribute_value.
CREATE TYPE value_kind AS ENUM ('text','number','date','bool','option','relation');

CREATE TYPE fact_source AS ENUM ('manual','import','quick_capture','agent','gmail','calendar','crawler');

CREATE TYPE created_via AS ENUM ('manual','import','api','agent');

CREATE TABLE workspace (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  -- ADR-060: the scalar freshness probe the nightly metrics sweep writes as its last statement.
  -- Derived from a data table it would couple two things that should not be coupled.
  metrics_swept_at  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- The single Phase-1 workspace. The uuid is a fixed literal, not gen_random_uuid(), so seeds,
-- fixtures and every test that binds $ws are reproducible across machines and re-creations.
INSERT INTO workspace (id, name)
VALUES ('00000000-0000-4000-8000-000000000001', 'Mutuals')
ON CONFLICT (id) DO NOTHING;

-- Single row, no auth in Phase 1.
CREATE TABLE profile (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspace(id) ON DELETE CASCADE,
  first_name   text NOT NULL,
  last_name    text NOT NULL,
  email        text,
  language     text NOT NULL DEFAULT 'en',
  -- ADR-045. Without phone_region '089 1234567' cannot be normalised at all; without time_zone the
  -- nightly warmth sweep would silently depend on the server's TZ environment variable.
  phone_region text NOT NULL DEFAULT 'DE',
  time_zone    text NOT NULL DEFAULT 'Europe/Berlin',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
