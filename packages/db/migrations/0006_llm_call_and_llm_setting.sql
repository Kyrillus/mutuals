-- The replayable LLM trace and the per-task model override.
--
-- Both are tables, and adding them in Stage 6 would be a second migration for no reason. Nothing
-- writes to either until the LLM module lands.

CREATE TABLE llm_call (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid REFERENCES workspace(id) ON DELETE CASCADE,

  -- what was asked
  task_kind         text NOT NULL CHECK (task_kind IN ('extraction','question','summary','embedding')),
  prompt_id         text NOT NULL,
  prompt_version    integer NOT NULL,
  prompt_hash       text NOT NULL,          -- sha256 of the rendered messages
  input_hash        text NOT NULL,          -- sha256 of canonicalJson(task input)

  -- who answered
  provider          text NOT NULL,
  base_url          text NOT NULL,
  model_requested   text NOT NULL,
  model_served      text,                   -- response.model; a gateway may serve a variant
  upstream_provider text,
  generation_id     text,

  -- the bytes, exactly. No API key is ever inside: auth lives in a header.
  request_body      jsonb,
  response_body     jsonb,

  -- what happened
  status            text NOT NULL CHECK (status IN
                      ('ok','invalid_json','schema_error','http_error','timeout','budget_exceeded','disabled')),
  http_status       integer,
  attempt           smallint NOT NULL DEFAULT 1,
  repair_of_id      uuid REFERENCES llm_call(id) ON DELETE SET NULL,
  error_detail      jsonb,                  -- zod issues, or the provider's error body
  parsed            jsonb,                  -- the VALIDATED task output; NULL unless status = 'ok'

  -- what it cost. 'estimated' is deliberately absent: the price table and the estimation
  -- arithmetic were dropped, and NULL with 'unreported' is a more honest record than an estimate
  -- from a cached price list.
  prompt_tokens     integer,
  completion_tokens integer,
  reasoning_tokens  integer,
  cached_tokens     integer,
  cost_usd          numeric(12,8),
  cost_source       text CHECK (cost_source IN ('reported','unreported','free')),
  latency_ms        integer,

  -- what it was about. SET NULL, not CASCADE: deleting a contact should not erase the cost record
  -- of work already paid for.
  record_id         uuid REFERENCES record(id) ON DELETE SET NULL,
  request_id        text,                   -- correlates with the HTTP access log
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX llm_call_created_idx ON llm_call (created_at DESC);
CREATE INDEX llm_call_task_idx    ON llm_call (prompt_id, prompt_version, created_at DESC);
CREATE INDEX llm_call_record_idx  ON llm_call (record_id, created_at DESC) WHERE record_id IS NOT NULL;
-- The replay probe: the newest successful call for this exact prompt, prompt text, model and input.
CREATE INDEX llm_call_replay_idx  ON llm_call (prompt_id, prompt_version, prompt_hash, model_requested,
                                               input_hash, created_at DESC)
  WHERE status = 'ok';
-- The budget probe, checked immediately before every billable HTTP POST.
CREATE INDEX llm_call_cost_idx    ON llm_call (created_at) WHERE cost_usd IS NOT NULL;

-- One row per task kind. It exists so "models swappable without a deploy" means a row update
-- rather than an env change plus a redeploy; the Settings page later becomes a form over a row
-- that already exists.
CREATE TABLE llm_setting (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
