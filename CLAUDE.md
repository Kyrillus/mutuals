# Working on Mutuals

A personal people CRM. **Read `docs/BRIEF.md` before changing anything** — it is the source of truth
for product decisions. `docs/DECISIONS.md` is the ADR log and is binding on architecture.

## The one rule

**Attribute definitions drive everything — never hard-code a column.** Users create fields at runtime.
Any code that names a user-facing field is wrong. Physical slot column names (`text_value`,
`num_value`, `date_value`, `bool_value`, `option_id`, `target_record_id`) appear in exactly one file,
`packages/core/src/attributes/slots.ts`, and a test asserts they appear nowhere else.

## Shape

```
apps/web ──HTTP──▶ apps/api ──▶ packages/db ──▶ packages/core
    │                                              ▲
    └────────── types + filter model ──────────────┘
```

One-way, enforced by ESLint. `packages/core` ships to the browser, so it may import nothing but `zod`
and `libphonenumber-js` — no Node builtins, no `pg`, no `kysely`, no `fastify`.

- **`packages/core`** — the domain. Attribute type registry, the filter _model_, warmth, identity
  normalisation and duplicate matching, recurrence, the API contract schemas. Pure and tested hard.
- **`packages/db`** — schema, migrations, the filter _compiler_, the write path, repositories.
- **`apps/api`** — Fastify. The only way into the data. An MCP server or a CLI would be another
  client of this, not another door.
- **`apps/web`** — React SPA. It talks to the API and never to the database.

## Data model, in one paragraph

`fact` is an append-only log: every value ever observed, with `valid_from`, `observed_at`, `source`
and `confidence`. It is the truth. `attribute_value` is its projection — every row current by
construction, so no query has a liveness predicate to forget — and it serves every `WHERE`, every
`ORDER BY` and every read. `record` is a supertype so `contact`, `organization` and `interaction`
share one id space and five polymorphic tables get real `ON DELETE CASCADE`. Relations live in
`record_link` because a link carries its own attributes (job title, from, to, primary). Derived
columns live in `contact_metrics`. Nothing is ever silently overwritten: a new value supersedes the
old one, and removing a multi-valued element writes a tombstone rather than a delete.

## Conventions

- Database identifiers are `snake_case`, everywhere, including the Kysely interface. No camelCase plugin.
- `erasableSyntaxOnly` is on: no `enum`, no parameter properties. Use `as const` objects plus a
  derived type. Relative imports carry the `.ts` extension.
- Text normalisation has **one** implementation and it is SQL (`mutuals_norm()`). TypeScript never
  produces a value that is compared against a normalised column. The casefold in
  `packages/core/src/text/` is display-only and nothing asserts it agrees.
- `now`, `today` and `timeZone` are injected parameters. Never read the wall clock in domain logic.
- Comments explain _why_. If a comment restates the line below it, delete it.
- Conventional Commits. The body explains why, not what.
- Everything is in English: code, comments, docs, commit messages, UI.

## Commands

```bash
pnpm dev          # the one command: database up, migrated, API and web running
pnpm db:up        # just the database (and it creates dev/test/e2e)
pnpm db:migrate   # migrations run explicitly, never on boot
pnpm seed         # ~200 contacts, 60 organizations, 500 interactions, 40 follow-ups
pnpm verify       # what CI runs: verify:static + verify:db
pnpm verify:e2e   # build, migrate mutuals_e2e, Playwright (its own CI job)
pnpm verify:full  # ...all three
pnpm openapi      # regenerate docs/openapi.json; CI fails if it differs
pnpm llm:relock   # rewrite the prompt lock after editing a prompt (ADR-067); CI enforces it
pnpm llm:record   # ONE live, billable model call, written to fixtures/llm/. Never in CI.
```

The e2e suite drives a **built** SPA on ports 3200/3201, never the dev server on 3000/3001 — it
truncates its database between tests and adopting `pnpm dev` would point that at `mutuals_dev`
(ADR-088). Chromium is installed once with
`pnpm --filter @mutuals/e2e exec playwright install chromium`.

`pnpm` is reached through `corepack pnpm` if it is not on your PATH — and the composite `verify`
scripts call `pnpm` themselves, so run `corepack enable pnpm` once or they fail with "command not
found". Docker lives at `~/.docker/bin` on the author's machine and is not on the default PATH
either. `docs/HANDOFF.md` has the rest of the environment notes.

## Stages

1. ~~**Foundation**~~ — migrations, domain core, query compiler, API skeleton, seed. **Done**, PR #1.
2. ~~**Contacts table + Settings → Attributes**~~ — app shell in light and dark; the DataTable, filter
   bar and contacts page; Settings and the attribute editor; Playwright e2e and the keyboard pass.
   **Done**, in PR #1 (ADR-089 — it grew to cover both stages rather than getting one of its own).
3. ~~**Organizations + relations + the contact detail page**~~ — the organizations table and detail
   page, contact↔organization links with their metadata, the contact detail page and §4.5's value
   history popover. **Done**, in PR #1 (ADR-089).
4. ~~**Follow-ups + dashboard + saved views**~~ — the follow-ups page with its quick-filter tabs and
   recurrence, §6.1's dashboard, and §6.6's saved views over ADR-048's URL-is-the-working-copy model.
   **Done**, in PR #1 (ADR-089).
5. ~~**Import wizard + duplicates + merge**~~ — §6.8's five-step wizard with CSV and XLSX, ADR-044's
   auto-mapping, duplicate detection against records _and_ within one file, and §6.9's merge for
   contacts and organizations. **Done**, in PR #1 (ADR-089); ADR-095 to ADR-101 record what it
   settled.
6. ~~**LLM layer (ask, quick capture, summaries) + command palette**~~ — the `llm/` module over an
   OpenAI-compatible port, the cost cap checked before every billable request, the `llm_call` trace,
   §4.8's "ask the network" with the filter it ran, §4.8's quick capture with an editable preview,
   §6.5's on-demand summary and §6.10's ⌘K palette over the new `search`. **Done**, in PR #1
   (ADR-089); ADR-102 to ADR-114 record what it settled.
7. **Polish and `v0.1.0`** ← _current_

Each stage ends with green CI, updated docs, a PR and a stop for approval.

## How to report back

Two layers, always (brief §0):

1. **Plain summary** — for Simon, who is not a developer. What was built, what he can click on, what
   you need from him. One screen. No code, no file paths.
2. **Technical detail** — for the co-founder. Architecture, trade-offs, test coverage, open questions.

When a decision is not covered by the brief: if it is small and reversible, pick the simplest option
and add an ADR to `docs/DECISIONS.md`. If it is large or hard to reverse, stop and ask.
