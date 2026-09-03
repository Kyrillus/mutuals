# Project Brief: Mutuals — the Personal People CRM for the Agentic Era

Product name: **Mutuals** (domain getmutuals.ai). Use it for the repo name, package scope, app title and README.

You are the lead engineer on a new open-source project. Read this whole brief before doing anything. It is long on purpose: it contains every product decision we have made so far, so you should not need to guess.

---

## 0. Who you are working with

Two people:

- **Simon** — product owner. Not a developer. He decides *what* gets built and how it should feel. Explain things to him in plain language: short sentences, no jargon, concrete examples. When you must use a technical term, explain it in half a sentence.
- **Simon's co-founder** — very technical. He reviews architecture, code quality and the technical plan. Talk to him like a senior engineer.

Every time you present a plan or a result, produce **two layers**:

1. **Plain summary (for Simon):** what will be built / was built, which decisions were made and why, what he can click on and try, what you need from him. Max. one screen of text. No code, no file paths.
2. **Technical detail (for the co-founder):** architecture, data model, libraries, trade-offs, file structure, test coverage, open questions.

Both layers must be approved before you proceed past a checkpoint (see §2).

---

## 1. Product vision

**One-liner:** *The personal people CRM for the agentic era.*

A tool for founders, investors, operators and community builders to keep track of everyone they know — and to have an agent inside the CRM that knows the whole network and can answer questions like:

> "I just met a health-tech founder in Munich who is raising €600k. Which investors in my network would be a fit?"

### What makes it different

- **Proactive.** It reminds you to stay in touch with the right people and nudges you with introduction ideas ("You just met X who needs Y — Z in your network does Y. Introduce them?").
- **Effortless to maintain.** Adding a contact or a note after a meeting takes seconds. The user should be able to type or dictate one sentence and the system fills the fields.
- **High data quality.** Duplicates are caught, every value knows where it came from, stale data is visible.
- **Highly customizable.** Users define their own attributes and table views. Nothing about the schema is hard-coded beyond a small core.
- **API-first and agent-ready.** Everything the UI can do, an API (and later an MCP server) can do. The UI is just one client.

### Product language

The product UI, code, comments, docs and commit messages are all in **English**.

### Users

For now: Simon, his co-founder and a handful of friends. Each runs their own instance. **No authentication, no multi-user, no multi-tenancy in this phase** (see §9 for what must stay possible later). Data privacy is not a design driver right now; private use only.

---

## 2. How you work on this project

### 2.1 Plan first, then approval, then build

Do **not** write application code before the plan is approved.

Step 0 — **Confirm the working directory.** Before you create or change a single file, tell Simon which folder you are in (full path) and ask him to confirm that this is where the project should live, or to name the correct folder. Do nothing else until he confirms.
Step 1 — **Read this brief and the reference screenshots** (see §11).
Step 2 — **Ask clarifying questions**, batched, only where this brief is genuinely ambiguous. Do not ask about things already decided here.
Step 3 — **Write the plan** as `docs/PLAN.md` with the two layers described in §0. The plan must contain: chosen stack with reasoning against the criteria in §3, data model, API surface, folder structure, the stage breakdown from §10 refined with your estimates, and a list of risks.
Step 4 — **Wait for explicit approval** from both people.
Once the plan is approved, move this file to `docs/BRIEF.md` and the screenshots to `docs/refs/`. `docs/BRIEF.md` is the **source of truth for product decisions** for the whole project. When a later decision changes something in it, update the brief in the same PR and note the change in `docs/DECISIONS.md`. Never let the brief and the code drift apart silently.
Step 5 — Build **stage by stage** (§10). At the end of every stage: stop, show what works (with instructions Simon can follow to try it), show test results, and wait for approval before starting the next stage.

### 2.2 Rules during implementation

- Small, reviewable increments. One stage = one or a few PRs.
- When you hit a decision this brief does not cover, do not silently pick one. If it is small and reversible, pick the simplest option and log it in `docs/DECISIONS.md` (one ADR per decision: context, options, choice, consequences). If it is large or hard to reverse, stop and ask.
- Prefer boring, well-documented technology over clever or new technology.
- Never over-engineer. Build what the current stage needs, but leave clean extension points where §9 says a feature is coming.
- If something in this brief turns out to be a bad idea once you are in the code, say so and propose an alternative. Do not build something you believe is wrong just because it is written here.

### 2.3 Communication

- Progress updates in the two-layer format (§0).
- When you ask Simon a question, offer 2–4 concrete options with a recommendation, not an open question.
- Use screenshots (Playwright) when showing UI results.

---

## 3. Tech stack

### 3.1 Fixed decisions (do not change)

- **Language:** TypeScript everywhere (frontend and backend).
- **Database:** **Postgres with JSONB + pgvector**, hosted on **Supabase** for the shared/deployed instance. Use Supabase **only as managed Postgres** — no Supabase Auth, no Edge Functions, no RLS-dependent logic, no Supabase client SDK in the app. The app must run against any plain Postgres 16 with `pgvector` and `pg_trgm`, so local development uses a Postgres container (docker compose) or the Supabase CLI — your call — and the project stays portable for open source. SQLite is ruled out.
- **Backend:** Node.js with **Fastify** as the HTTP framework. (If you see a reason to prefer Hono, say so in the plan; do not switch silently.)
- **LLM access:** all model calls go through **OpenRouter** (OpenAI-compatible API, one key, any model). Model names are configuration, not code: one setting per task (extraction, question answering, summaries, embeddings) so cheap and strong models can be mixed and swapped without a deploy. Keep the provider behind an interface anyway so a direct Anthropic/OpenAI/Ollama endpoint can be plugged in by changing the base URL. If OpenRouter does not cover embeddings well enough at build time, use a second provider for embeddings behind the same interface and document it.
- **Frontend:** React + Tailwind CSS + **shadcn/ui**. shadcn components are copied into the repo (that is how shadcn works) and may be adapted. Use shadcn's data-table pattern (TanStack Table) as the base for all tables.
- **Animations:** none beyond shadcn defaults in Phase 1. Structure components so **animate-ui** (built on shadcn + Motion) can be added later without rewriting.
- **Monorepo** with clear packages, e.g. `apps/web`, `apps/api`, `packages/core` (domain logic, shared types), `packages/db`. Exact layout is your call; justify it in the plan.
- **API-first:** the web app talks to the backend only through the public API. No direct database access from the frontend. The same API will later serve an MCP server, a CLI and integrations.
- **Runs locally with one command** (`docker compose up` or a single `pnpm dev`). No cloud dependency required to run it.
- **Open-source friendly:** permissive licence (MIT), no proprietary services in the critical path, `.env.example` for every secret.

### 3.2 Your decisions, judged against these criteria

Choose and justify in the plan:

**Database schema strategy (Postgres is fixed).** Must support (a) a dynamic attribute system where users create fields at runtime (§4.2) with efficient filtering and sorting on those fields, (b) relations between records, (c) full-text search now (`tsvector`) and vector embeddings later (§9, `pgvector`) — all in the one database, no second datastore. Explain JSONB-with-GIN vs. EAV vs. hybrid for the custom attributes and state the trade-off explicitly.

**API style.** Typed end-to-end (the frontend should get types from the API without hand-writing them). REST with OpenAPI generated from schemas (e.g. Zod + fastify-type-provider) is the default; if you propose tRPC, explain how a REST/OpenAPI surface will still be exposed for non-TypeScript clients (MCP server, Python scripts).

**ORM / query layer.** Must handle the dynamic attribute filtering (§4.2) without becoming unreadable and must work with `pgvector`. Drizzle is the leading candidate; justify your pick. Migrations must be versioned, in the repo and reproducible.

**Background jobs.** Imports, LLM summaries and (later) sync and nudges need a queue. Prefer a Postgres-backed queue (e.g. pg-boss) over extra infrastructure. Justify.

**LLM usage (OpenRouter is fixed).** Phase 1 needs: (a) structured extraction from free text into attribute values, (b) natural-language question → structured query + answer, (c) short per-contact summaries. Use structured/JSON-schema outputs for everything that is parsed by code. Every call goes through one internal `llm/` module with typed inputs and outputs, prompt versioning, cost logging and a replayable trace — no LLM calls scattered through business logic. **The LLM extracts; code decides.** In particular, matching free text to an existing contact (quick capture, duplicate detection) is done by deterministic code with confidence scores and, when unsure, a question to the user — never by the model alone.

**Testing.** Unit tests for domain logic, integration tests for the API against a real database, a small number of Playwright end-to-end tests for the critical flows (create contact, import, create attribute, filter table). Pick tools; justify.

**Tooling.** pnpm, ESLint, Prettier, strict TypeScript, a CI workflow (GitHub Actions) that runs lint, typecheck, tests.

---

## 4. Domain model

### 4.1 Core objects

There are four first-class objects. Each has a small set of **system attributes** (hard-coded, cannot be deleted) and any number of **custom attributes** (§4.2).

#### Contact
A person.
System attributes: `id`, `first_name`, `last_name`, `display_name` (derived), `created_at`, `updated_at`, `provenance` (§4.4).
Default custom attributes created on first run (user may edit/delete these; they are just seeds):
`email` (email), `phone` (phone), `job_role` (single select: Founder, Investor, Operator, Student, Community Builder, Other), `organization` (relation → Organization, many, with `from`/`to` dates and `title` on the link — see §4.3), `city` (short text), `country` (short text), `birthday` (date), `areas_of_interest` (tags), `asks` (tags — what this person is currently looking for, e.g. "seed investor", "CTO", "climate-tech deals"), `offers` (tags — what this person can give, e.g. "seed investing", "intro to Stripe", "hardware manufacturing"), `linkedin_url` (url), `website` (url), `how_we_met` (long text), `notes` (long text).
`asks` and `offers` matter: they are the basis for future introduction suggestions (§9), which must only ever be made on an ask↔offer match, never on topic similarity.
Derived (read-only, computed) columns on Contact: `last_interaction_at`, `interaction_count_12m`, `open_followups`, and `warmth` (§4.7).

#### Organization
A company, fund, university, community — any entity people belong to. (Deliberately not called "Company": investors work at funds, angels have no company.)
System attributes: `id`, `name`, `created_at`, `updated_at`, `provenance`.
Default custom attributes: `type` (single select: Startup, VC Fund, Angel, Corporate, University, Community, Other), `industry` (tags), `city`, `country`, `website` (url), `linkedin_url` (url), `description` (long text), `stage` (single select: Pre-seed, Seed, Series A, Series B+, Public, N/A).

#### Interaction
One touchpoint with one or more contacts. This is the raw material for "last contact X weeks ago", for the activity timeline and for the agent's context.
Fields: `id`, `type` (enum: Meeting, Call, Email, Message, Intro, Event, Note), `occurred_at` (datetime), `title` (short text), `body` (long text, markdown), `contacts` (relation → Contact, many), `organizations` (relation → Organization, many, optional), `source` (enum: manual, import, gmail, calendar, whatsapp, telegram, agent — only `manual` and `import` are used in Phase 1), `created_at`, `updated_at`.
Interactions do **not** get custom attributes in Phase 1, but model them so it would be a small change.

#### Follow-up
A reminder to do something with a contact.
Fields: `id`, `title`, `contact` (relation → Contact, one, required), `due_at` (date), `status` (Open, Done, Snoozed), `recurrence` (none, or an RRULE-style rule: weekly / monthly / every N months / yearly), `origin` (enum: manual, system — `system` reserved for future automatic nudges), `notes` (long text), `completed_at`, `created_at`, `updated_at`.
When a recurring follow-up is marked Done, the next occurrence is created automatically.

### 4.2 Custom attribute system (the heart of the product)

Users define attributes per object type (Contact, Organization) in Settings. This is the same idea as Tacto's "Supplier attributes" or Notion's database properties.

An **Attribute Definition** has:
- `id`
- `object_type` (contact | organization)
- `title` — display name, editable
- `slug` — machine name, **immutable after creation**, unique per object type, lowercase snake_case, auto-suggested from the title, validated against a reserved list (system attribute names, SQL keywords, etc.)
- `type` — one of the types below
- `config` — type-specific options (e.g. the option list for selects, min/max for number, target object for relation)
- `group` — optional free-text group name; controls how attributes are grouped on the detail page (§6.5)
- `description` — optional help text
- `is_system` — true for the hard-coded ones; system attributes cannot be deleted or have their type changed
- `position` — for ordering
- `created_at`, `updated_at`

**Attribute types (all required in Phase 1):**

| Type | Stored as | UI | Filter operators | Sort |
|---|---|---|---|---|
| `short_text` | string (≤ 255) | single-line input | contains, equals, is empty | alphabetical |
| `long_text` | string (markdown) | textarea | contains, is empty | — |
| `number` | decimal | number input, optional unit/decimals in config | =, ≠, <, >, between, is empty | numeric |
| `date` | date (no time) | date picker | before, after, between, is empty; relative shortcuts (last 30 days, this year) | chronological |
| `yes_no` | boolean (nullable) | switch / tri-state | is yes, is no, is empty | yes first |
| `single_select` | option id | select; options with label + colour in config | is one of, is not one of, is empty | option order |
| `multi_select` | option id[] | multi-select | contains any of, contains all of, is empty | — |
| `tags` | string[] | tag input; **new values can be created inline** without going to Settings; existing values are suggested | contains any of, is empty | — |
| `url` | string | input, rendered as link | contains, is empty | — |
| `email` | string | validated input, rendered as mailto | contains, is empty | alphabetical |
| `phone` | string | input, normalised to E.164 where possible | contains, is empty | — |
| `relation` | record id(s) | searchable picker; config: target object type, one-or-many, optional link metadata (§4.3) | has any of, is empty | — |

Deleting an attribute definition deletes its values (after a confirmation dialog that states how many records have a value). Changing the type of an attribute is **not** supported; the UI must say so.

**Storage requirement:** filtering and sorting on any custom attribute across thousands of records must be fast enough to feel instant in the table. Explain your approach (JSONB with GIN indexes, EAV table, hybrid) and its limits in the plan.

### 4.3 Relations

- Contact ↔ Organization is the most important relation. The link itself carries metadata: `title` (e.g. "Co-Founder"), `from` (date), `to` (date, null = current), `is_primary`. This is what makes a contact's work history visible.
- Contact ↔ Contact relations must be possible via the `relation` attribute type (e.g. "introduced_by", "knows"). Not seeded by default.
- All relations are bidirectional in the UI: if contact A links to organization B, B's detail page lists A.

### 4.4 Provenance

Every Contact and Organization carries a `provenance` object:
- `created_via` — `manual` | `import` | `api` | `agent`
- `created_at`
- `import_batch_id` (if import) → links to an **Import Batch** record with `file_name`, `imported_at`, `row_count`, `object_type`, `mapping` (the column mapping used).
- `last_enriched_at`, `enriched_by` — reserved for the future crawler; nullable now.

The UI shows a small marker on each record: "Created 12 Mar 2026" or "Imported 12 Mar 2026 from `linkedin_connections.csv`". Per-value provenance is handled by the facts layer (§4.5).

### 4.5 Facts: value history behind every attribute

Attributes are the *schema* the user sees. Behind each attribute value sits an append-only **fact log**, so nothing is ever silently overwritten and the agent can reason about *when* and *from where* it learned something.

A **Fact** row: `id`, `object_type`, `record_id`, `attribute_id`, `value` (typed, JSON), `valid_from` (date the fact became true, defaults to `observed_at`), `observed_at` (when we learned it), `source` (`manual` | `import` | `quick_capture` | `agent` | `gmail` | `calendar` | `crawler`), `source_ref` (e.g. import batch id, interaction id), `confidence` (0–1; 1.0 for manual), `superseded_by_id` (nullable), `created_at`.

Rules:
- The **current value** of an attribute on a record is the newest non-superseded fact. Store or materialise it so table filtering/sorting stays fast (a `current_values` JSONB per record refreshed on write is fine — the fact log is the truth, the JSONB is the index).
- Single-valued attributes (text, number, date, single select, yes/no, url, email, phone, relation-one): a new fact supersedes the previous one. Multi-valued attributes (tags, multi select, relation-many): facts are added and removed individually; removal is a fact with a `removed_at`, not a delete.
- Facts are never hard-deleted while the record exists. Deleting a record deletes its facts.
- UI in Phase 1: on the contact detail page, hovering or clicking an attribute value shows its history ("Company: Stripe — since Jun 2025, from LinkedIn import · previously Northstar — Jan 2023, manual"). Nothing more. The history is otherwise invisible; the user works with attributes as usual.
- This is what makes later features cheap: an LLM extracting "she moved to Berlin" from a voice note just appends a fact with `source = quick_capture` and `confidence 0.9`; the crawler appends with `source = crawler`; a conflict between two sources is visible instead of lost.

### 4.6 Identifiers

A separate **Identifier** table holds every handle we have ever seen for a contact or organization: `record_id`, `kind` (`email` | `phone` | `linkedin_url` | `website` | `google_contact_id` | `telegram` | `whatsapp` | `other`), `value` (normalised: lowercased email, E.164 phone, canonical LinkedIn slug), `source`, `created_at`. Unique on (`kind`, `value`).
This is the primary key for duplicate detection and merging (§6.8, §6.9): two rows sharing any identifier are the same entity with near-certainty; name + organization similarity is the fallback, never the first check. The `email`, `phone`, `linkedin_url` and `website` attributes write through to this table automatically.

### 4.7 Warmth score

A derived number 0–100 per contact: how alive the relationship is. Recomputed nightly (and on demand after new interactions) by a pure function in `packages/core` with unit tests:

```
signal = Σ over interactions in the last 365 days of weight(type) × exp(−days_ago / 90)
weight: Meeting 3.0, Call 2.5, Event 2.0, Intro 2.0, Note 1.5, Message 1.0, Email 0.7
warmth = round(100 × (1 − exp(−k × signal)))   — choose k so one meeting per month ≈ 75
```
Manual override on the contact: `pinned_important` (floor 60) and `not_important` (cap 10, excluded from future nudges). Warmth is a derived column in tables (sortable, filterable), a small indicator on the detail page, and later the node size in the network graph.

### 4.8 Search and the agent (Phase 1 scope)

- **Global search** (top of sidebar): substring search across contact names, organization names, emails and interaction titles. Results grouped by object type. Keyboard shortcut ⌘K / Ctrl+K.
- **Ask the network** (dashboard input field, §6.1): the user types a natural-language question. Phase 1 implementation: the LLM receives the schema (attribute definitions), converts the question into a structured filter over the API, executes it, and writes a short answer that lists the matching records as clickable chips. It must show *which filter it ran* so the user can trust or correct it. Semantic/embedding search is a later stage (§9) — design the interface so it can be swapped in.
- **Quick capture** (global "+" or shortcut): the user types free text like *"Met Anna Berger from Northstar Ventures at Bits & Pretzels, she's looking for climate-tech seed deals, follow up in 3 weeks"*. The LLM proposes: a new or matched Contact, a new or matched Organization, an Interaction, and a Follow-up — shown as an editable preview that the user confirms with one click. Nothing is saved before confirmation. Voice input is later; text is now.

---

## 5. Shared UI patterns

Every page follows the same skeleton so the app feels like one product. Reference: the Tacto screenshots in §11.

### 5.1 App shell
- Left sidebar, ~240px, light grey background: workspace switcher / logo at the top (click → menu with Settings), global Search, then navigation: Dashboard, Contacts, Organizations, Follow-ups. Collapsible.
- Top bar with breadcrumb (e.g. `Contacts › Anna Berger`).
- Content area max-width ~1200px, generous padding, white background.
- Visual style: neutral greys, one accent colour, thin borders, 13–14px base font, small rounded chips for select values (coloured by option), avatar circles with initials. Match the density and calm of the Tacto screenshots — this is a working tool, not a marketing page.

### 5.2 The data table (one shared component, used on every list page)
Build **one** `DataTable` component driven by attribute definitions and reuse it for Contacts, Organizations, Follow-ups, Interactions, Attributes list and Import preview. Features:

- **Filter bar** at the top left: `+ Add filter` opens a picker of all attributes; each active filter is a chip (`Job role is one of Investor, Angel`) that can be edited or removed. Operators per type as in §4.2. Filters combine with AND. Filters are reflected in the URL so views can be shared/bookmarked.
- **Search box** top right: quick substring search over visible text columns.
- **Columns** button (`Columns 10/14`): toggle visibility and reorder by drag.
- **Sort** by clicking a column header; second click reverses; arrow indicator in the header. Multi-sort not required.
- **Saved views** (§6.6): a view = a named set of visible columns + order + filters + sort. The current view name shows in the breadcrumb (`Contacts › Investors in Munich`). A `⋮` menu offers `Save changes to view`, `Save as new view`, `Revert changes`, `Table settings`.
- **Row selection** checkboxes with a bulk action bar (delete, add tag, export selection as CSV).
- **Row count** in the footer (`Rows: 2,236`).
- **Primary action** top right: black `+ Add new` button with a dropdown: `Add single …` and `Bulk import …`.
- Cells render by type: select values as coloured chips, relations as chips with an icon that link to the record, urls as links, booleans as check/cross, empty as a subtle placeholder.
- **Inline editing** of cells (double-click or Enter) for text, number, date, select, tags, yes/no. Save on blur; optimistic update; error toast on failure.
- **Derived columns**: some columns are computed, not stored (e.g. `Last interaction`, `People` count, `Open follow-ups`). The DataTable and the filter model must support these read-only columns with their own filter operators (e.g. "Last interaction is more than 90 days ago"). Define them in code next to the system attributes so they appear in the Columns picker like any other attribute.
- Virtualised rows; must stay smooth at 10k rows.
- Loading skeletons, empty state with a call to action, error state.

### 5.3 Record creation dialog
`Add single …` opens a right-side sheet or centred dialog: required fields marked with a red asterisk, system fields first, then custom attributes grouped by `group`. Cancel / primary Save. After save: toast with a link to the new record.

### 5.4 Confirmation dialogs
Destructive actions (delete record, delete attribute, import confirm) always confirm, stating the consequence in numbers ("This will delete 3 contacts and 12 interactions.").

---

## 6. Pages and features (Phase 1)

### 6.1 Dashboard (home)
Reference: `01-dashboard.png`.
- Greeting with the user's first name (from Profile) and today's date.
- **Ask the network** — a prominent single input directly under the greeting: placeholder *"Ask anything about your network…"*. Submitting runs the flow from §4.8 and renders the answer below the input, with the executed filter shown in a collapsible "How I searched" section and results as record chips.
- **Key numbers** row (stat cards): total contacts, contacts added in the last 30 days, follow-ups due this week, follow-ups overdue. Each card links to a pre-filtered view.
- **Quick links** row (three cards like Tacto's "Find a supplier / Findings / Tasks"): Contacts, Organizations, Follow-ups.
- **"Needs your attention"** list: overdue and upcoming follow-ups (next 7 days), each row with contact chip, due date (red if overdue), and a Done checkbox inline.
- **Recently added / recently interacted** list: last 10 contacts by interaction date.
- A placeholder section for future charts (§9) is **not** needed; just keep the layout grid extensible.

### 6.2 Contacts
Reference: `02-contacts-table.png`, `03-add-new-menu.png`, `05-add-contact-form.png`.
- DataTable (§5.2) over Contacts with the default view showing: Name (avatar + display name, sticky first column, click → detail), Email, Phone, Organization (chips), Job role, City, Areas of interest, Last interaction (derived, relative: "3 weeks ago"), Created.
- Default seeded views: `All contacts`, `Investors`, `Founders`, `No interaction in 90 days`.
- `+ Add new` → `Add single contact` (dialog: first name*, last name*, email, phone, organization picker with title, job role, city, then all other custom attributes collapsed under "More") | `Bulk import contacts` (§6.8).

### 6.3 Organizations
Reference: `06-companies-table.png` (shows Tacto's contacts table; use it only for layout).
- DataTable over Organizations. Default columns: Name (sticky), Type, Industry, City, Country, People (count of linked contacts, click → filtered contacts), Website, Created.
- `+ Add new` → single | bulk import.
- Detail page (§6.5 variant): header with name, type chip, city, website; tabs Overview (description, attributes sidebar, linked people list with title and dates, recent interactions) and Activities.

### 6.4 Follow-ups
Reference: `07-reminders-table.png`.
- DataTable over Follow-ups. Default columns: Status (icon: open circle / done check / snoozed clock; click toggles Done), Title, Contact (chip), Due date (red when overdue), Recurrence (chip: "Monthly"), Notes preview, Created.
- Quick filter tabs above the table: `Open`, `Overdue`, `Done`, `All`.
- `+ Create follow-up` top right: dialog with title*, contact* (searchable picker), due date* (with shortcuts: in 1 week, in 1 month, in 3 months), recurrence (none / weekly / monthly / every 3 months / every 6 months / yearly / custom every N days), notes.
- Marking a recurring follow-up done creates the next one (§4.1). Snooze offers +1 day, +1 week, pick a date.
- Bulk actions: mark done, delete, reassign due date.

### 6.5 Contact detail page
Reference: `15-contact-detail.png`.
Layout: header, tab bar, main column, right sidebar.

**Header:** avatar (initials, or photo later), display name, one line of context: primary organization + title · city · chips for job role · icon links for email, phone, LinkedIn, website. Provenance marker (§4.4) in small grey text. `⋯` menu: edit, merge into another contact (see §6.9), delete.

**Tabs:**
- **Overview**
  - *Highlights* row with two cards: (1) **Summary** — LLM-generated 2–3 sentence summary of who this person is and what they currently need, generated on demand via a button and cached with a timestamp, with a "regenerate" action; shows an empty state until generated. (2) **Relationship** — last interaction (relative date), number of interactions in the last 12 months, open follow-ups count, next follow-up date.
  - *Activities* — the 3 most recent interactions with type icon, title, relative date; `+ New activity` button; `See all →` switches to the Activities tab.
  - *Open follow-ups* — list with inline Done; `+ Add follow-up`.
- **Activities** — full chronological timeline of Interactions for this contact, newest first, grouped by month. Each item: type icon, title, body (markdown, collapsible), other participants as chips, source badge (`manual` / `import`). Create, edit, delete inline. Filter by type.
- **Connections** — (a) Organizations: list of linked organizations with title, from/to, primary badge; add/edit/remove link. Ordered current → past, so it reads as a CV. (b) People: contacts linked through any contact→contact relation attribute, grouped by attribute (e.g. "Introduced by", "Knows"). (c) "Also at the same organization": other contacts sharing a current organization (derived, read-only).
- **Follow-ups** — all follow-ups for this contact, open and done, same DataTable.

**Right sidebar ("All information"):** every attribute, grouped by `group` (ungrouped ones under "Details"), each row = label + typed inline-editable value (like Tacto's right column). Empty values show a subtle "Add …" affordance. Groups collapsible. A small history icon per value opens the fact history (§4.5). Warmth (§4.7) is shown as a compact indicator under the header, not as an editable field.

Deliberate deviations from Tacto: no separate "Contact data" tab (email/phone live in the header and sidebar); no Documents / Negotiation / Transactions tabs; no "Individual views" configurator in Phase 1 (the attribute `group` field covers it).

### 6.6 Settings
Reference: `08-workspace-menu.png`, `09-settings-profile.png`, `10-settings-objects.png`, `11-attributes-list.png`, `12-create-attribute.png`.
Entry: click the logo/workspace name top-left → menu with `Settings`, `Help & support` (link to README), and later `Switch workspace` (greyed out placeholder is fine).
Settings has its own left nav: **Account → Profile**; **Objects → Contacts, Organizations**. Nothing else in Phase 1.

- **Profile:** first name*, last name*, email, language (English only for now, but store the field), and a placeholder section for password (disabled with a note "Authentication coming later"). No password/auth logic in Phase 1.
- **Objects → Contacts** (and identically **Organizations**): a card list with two entries, each showing a count and a chevron:
  - **Attributes** (`14 attributes`) → §6.7
  - **Table views** (`4 views`) → list of saved views for this object; click a view to edit its name, visible columns (checkbox list with drag to reorder), default filters and default sort; set one view as default; delete view (with confirmation). `+ Add new` creates a view.

### 6.7 Attribute management
Reference: `11-attributes-list.png`, `12-create-attribute.png`.
- DataTable of attribute definitions: Title, Slug, Type (icon + label), Group, Used in (count of records with a value), Created, Updated. Filter and search. System attributes are shown with a lock icon and cannot be deleted.
- `+ Add new` opens the **Create attribute** dialog: Title* (auto-generates Slug), Slug* (editable until saved, then locked; helper text "Unique, cannot be changed after creation"), Type* (select with icons), Group (combobox: pick existing or type new), Description, and type-specific config (options editor with label + colour for selects; target object and one/many for relation; unit and decimals for number). Save / Cancel. Live validation with inline error messages exactly like the reference ("Title is required").
- Click a row → edit dialog: everything editable except slug and type; select options can be added, renamed, recoloured, reordered; deleting an option that is in use asks whether to clear or remap values.
- Delete attribute → confirmation stating how many records have a value.

### 6.8 Import wizard
Reference: `13-import-column-mapping.png`, `14-import-review.png`.
Entry: `+ Add new → Bulk import` on Contacts or Organizations, or Settings. Full-page wizard with a stepper: **Upload → Sheet → Map columns → Review → Done**.

1. **Upload.** Dropdown *"What are you importing?"* (Contacts / Organizations — preselected from where the user came from) and a dropdown *"Source format"* with presets: `Generic CSV/Excel`, `LinkedIn Connections export`, `Google Contacts CSV`, `Apple Contacts vCard (.vcf)`. Drop zone accepting `.csv`, `.xlsx`, `.vcf`. Presets pre-fill the column mapping in step 3 (e.g. LinkedIn: First Name, Last Name, URL, Email Address, Company, Position, Connected On → creates the Organization link with title=Position and from=Connected On). File is parsed in the browser or streamed to the API — your call; must handle 10k rows.
2. **Sheet.** Only for `.xlsx` with multiple sheets: pick one. Skipped otherwise.
3. **Map columns.** One card per source column, exactly like the reference: column letter, source header, arrow, target attribute select (with `Create new attribute…` at the bottom that opens the §6.7 dialog inline), and a right-hand status: "Auto-mapped to EMAIL" (green check) / "Not mapped — will be skipped" (grey) / warning. For select/tags targets, expand to show **value mapping**: each distinct source value → existing option or `Create option` (as in the reference's Country and ISIC rows). Show "% of rows have a value". Auto-mapping uses header similarity (exact, case-insensitive, synonyms like "E-Mail"/"Email Address", and preset knowledge). A `Confirm mapping` button.
4. **Review.** Spreadsheet-style grid of the parsed rows with the target columns. Toolbar: `Find errors` (highlights rows failing validation: required field missing, invalid email, unknown select option, bad date), tabs `All rows` / `Error rows (n)`, undo/redo, `Find & replace`, `Export as Excel`. Cells are editable in place to fix errors. **Duplicate detection** runs here: rows matching an existing record (same email, or same normalised full name + organization) are flagged with a chip `Possible duplicate of Anna Berger` and a per-row choice: `Skip` / `Merge into existing` (fill empty fields only) / `Create anyway`. A bulk choice for all duplicates is offered. Rows with unresolved errors are skipped, and the button says so: `Import 1,204 rows (23 will be skipped)`.
5. **Confirm & Done.** Confirmation dialog ("Import 1,204 contacts from linkedin_connections.csv? This cannot be undone automatically."). Progress bar. Result screen with counts (created, merged, skipped), link to the filtered table (`provenance.import_batch_id = …`), and a downloadable error report for skipped rows. The Import Batch record is stored (§4.4).

Import must be idempotent enough that re-importing the same LinkedIn export creates no duplicates when the user picks `Skip` or `Merge` for flagged rows.

### 6.9 Merge contacts
From a contact's `⋯` menu and from the duplicate flow: pick the other contact, see a side-by-side of all attributes with a radio per field to choose the surviving value, interactions and follow-ups are moved to the survivor, the other record is deleted. Confirmation required. Same for organizations (lower priority; can be Stage 6).

### 6.10 Global search and quick capture
- ⌘K opens a command palette (shadcn `Command`): search across records (§4.8), plus actions: New contact, New organization, New follow-up, New interaction, Quick capture, Go to Settings.
- **Quick capture** (§4.8) is available from the palette and from a `+` in the top bar. Preview → confirm → saved. The preview must make clear which records are *new* and which are *matched existing* (with a way to change the match).

---

## 7. Public API

- Versioned (`/api/v1`). Documented (OpenAPI, served at `/api/docs`).
- Resources: contacts, organizations, interactions, follow-ups, attribute-definitions, views, import-batches, search, ask, quick-capture.
- Filtering, sorting and pagination on list endpoints use the same filter model the DataTable uses, serialised in the query string; document it with examples.
- Consistent error shape, validation errors per field.
- API key auth is **out of scope** now, but leave a middleware slot so a bearer token check can be added later without touching handlers.
- Write the API so an **MCP server** can be added as a thin adapter in a later stage: every operation the UI performs must be a single, well-named API operation, not a sequence of UI-only calls.

---

## 8. Quality, tests, git, documentation

### 8.1 Tests
- Domain logic (attribute validation, slug generation, filter → query compilation, duplicate matching, recurrence computation, import mapping/preset logic): unit tests, high coverage — these are the parts that break silently.
- API: integration tests against a real database (test containers or a dedicated test DB), covering each resource's happy path and validation errors, plus the dynamic filter/sort on custom attributes.
- UI: Playwright e2e for: create attribute → appears in table → filter by it; import a LinkedIn CSV fixture end-to-end with a duplicate; create contact → add interaction → add follow-up → mark done (recurring creates next); saved view round-trip.
- Provide realistic **seed data**: ~200 contacts, ~60 organizations, ~500 interactions, ~40 follow-ups, with a `pnpm seed` script, so Simon can click around immediately. Include a `fixtures/linkedin_connections_sample.csv` and a `fixtures/google_contacts_sample.csv`.
- CI must be green before you report a stage as done.

### 8.2 Git
- `main` is always runnable. Work on feature branches per stage (`stage-1-foundation`, …) or smaller.
- Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`), small commits, imperative subject, body explains *why*.
- One PR per stage (or a few), with a description containing: the two-layer summary (§0), how to test manually, screenshots, and a checklist of the stage's definition of done.
- Never force-push `main`. Never commit secrets. `.env.example` always up to date.

### 8.3 Documentation (keep these current as you go — they are part of every stage's definition of done)
- `README.md` — a placeholder already exists; keep its vision section at the top and replace the "Status" and technical parts as the project grows: what the product is, screenshots, one-command setup, how to import your LinkedIn export, how to configure an LLM provider, contribution notes, licence.
- `CLAUDE.md` — instructions for future AI-assisted sessions: architecture overview, where things live, conventions, how to run tests, the rule "attribute definitions drive everything — never hard-code a column", the stage list and current status, and the two-layer communication rule. Keep it under ~150 lines; link to the docs below for detail.
- `docs/ARCHITECTURE.md` — packages, data flow, the dynamic attribute storage and query approach, the LLM provider abstraction, extension points for §9.
- `docs/DECISIONS.md` — ADR log (§2.2).
- `docs/PLAN.md` — the approved plan; update the status per stage.
- `docs/API.md` or generated OpenAPI — the filter model with examples.
- Code comments only where the *why* is not obvious. Public functions in `packages/core` get a short doc comment.

---

## 9. Explicitly out of scope for Phase 1 — but design for them

Do **not** build these now. Do leave the named extension points, and mention in `docs/ARCHITECTURE.md` how each would plug in.

| Later feature | Extension point to keep now |
|---|---|
| Semantic search / embeddings over contacts and interactions | LLM provider interface exposes `embed()`; DB choice supports a vector column; `search` API has a `mode` parameter (`keyword` now, `semantic` later) |
| Synergy nudges ("X needs Y, Z has Y — introduce them") and stay-in-touch nudges | Follow-up `origin = system`; `asks`/`offers` attributes exist from day one; warmth (§4.7) gives "who matters"; a `jobs` package/folder with a scheduler stub. Rule for later: intro suggestions only on an ask↔offer match, never on topic similarity |
| Chat channels (Telegram first, then WhatsApp Business API) for voice-note capture, queries and a daily digest — the co-founder's "Mutuals" blueprint | Channel adapters are API clients; `quick-capture` and `ask` endpoints are the whole surface they need; Interaction `source` enum covers them; Fact `source` covers `quick_capture` |
| Voice input for quick capture | Quick capture takes plain text; a speech-to-text step just prepends |
| WhatsApp / Telegram bot to query and add via chat | The bot is one more API client; `ask` and `quick-capture` endpoints are already the whole surface it needs |
| Gmail and Google Calendar sync (interaction strength, auto-logged meetings) | Interaction `source` enum already includes `gmail`, `calendar`; an `integrations/` folder with a provider interface (`fetchSince(cursor)`); a `sync_state` table stub is fine |
| Enrichment crawler (website, public profiles) | `provenance.last_enriched_at / enriched_by`; per-value provenance migration path documented |
| Network graph visualisation (node size = connection strength) | Relations are first-class and queryable via API (`/contacts/:id/connections`); interaction counts per pair are cheap to compute |
| Dashboard charts (contacts over time, by role, by city) | Stat-card API endpoints return simple aggregates; keep a `/stats` route |
| Authentication, multiple users, hosted multi-tenant | Every table gets a nullable `workspace_id` column now (always the single default workspace); API middleware slot for auth (§7); never rely on global singletons for "the current user" |
| CLI client | Just another API consumer; nothing to do now |
| MCP server | Thin adapter over the API (§7) |
| animate-ui animations | Components stay shadcn-standard so animate-ui variants can replace them |
| Desktop app | Not relevant now; nothing to do |

---

## 10. Stages (Phase 1)

Refine this in the plan with estimates. Each stage ends with: green CI, updated docs, a PR, a two-layer report, a stop for approval. Simon must be able to run the app locally after **every** stage from Stage 2 onwards.

**Stage 0 — Plan.** Questions, `docs/PLAN.md`, `docs/DECISIONS.md` with the stack ADRs. Approval gate.

**Stage 1 — Foundation.** Monorepo, tooling, CI, database, migrations, the four core objects with system attributes, the attribute-definition model, the fact log with materialised current values (§4.5), the identifier table (§4.6), the warmth function (§4.7), the dynamic-attribute storage and the filter/sort query compiler with unit tests, API skeleton with OpenAPI, seed script. Deliverable for Simon: "the engine runs; here is the API docs page".

**Stage 2 — Contacts table + Settings → Attributes.** App shell, DataTable component, Contacts list with filters/sort/columns/inline edit, Add single contact dialog, Settings with Profile and Contact attributes (create/edit/delete, all 12 types). Deliverable: Simon can create attributes and see them as columns, filter and sort by them.

**Stage 3 — Organizations + Relations + Contact detail page.** Organizations table and detail, contact↔organization links with metadata, Contact detail page with Overview / Activities / Connections / Follow-ups tabs and the attribute sidebar, Interactions CRUD. (LLM summary card can be a stub until Stage 6.)

**Stage 4 — Follow-ups + Dashboard (without Ask).** Follow-ups table, recurrence, snooze, dashboard stat cards and attention list, saved table views (create/edit/set default) in Settings and via the `⋮` menu.

**Stage 5 — Import wizard + duplicates + merge.** Full wizard, presets (LinkedIn, Google Contacts, vCard), value mapping, review grid, duplicate detection, merge UI, import batches and provenance markers.

**Stage 6 — LLM layer.** Provider abstraction (Anthropic + OpenAI-compatible), Ask the network (question → filter → answer with "how I searched"), Quick capture (text → preview → confirm), contact Summary card. Command palette.

**Stage 7 — Polish and release.** Empty states, keyboard shortcuts, error handling, performance pass at 10k rows, README with screenshots, licence, `CLAUDE.md` final, tag `v0.1.0`.

---

## 11. Reference screenshots

The `refs/` folder next to this file contains screenshots of Tacto, a B2B procurement tool whose interface we like. **Copy the layout, density and interaction patterns. Do not copy the domain (suppliers, orders, ESG).** Where this brief deviates from a screenshot, the brief wins.

| File | Shows | Use for |
|---|---|---|
| `01-dashboard.png` | Dashboard: greeting, three quick-link cards, KPI cards with sparklines, "My work" list with tabs and counts | §6.1 layout |
| `02-contacts-table.png` | Full data table: filter chips, search, Columns 17/19, `⋮`, black `Add new`, sticky ID+name column, chips, flags, row count | §5.2 |
| `03-add-new-menu.png` | `Add new` dropdown: single vs bulk import | §5.2 |
| `04-table-settings-menu.png` | `⋮` menu: Revert changes, Save changes…, Table settings | §5.2 saved views |
| `05-add-contact-form.png` | Create dialog: required asterisks, grouped fields, Cancel/primary | §5.3 |
| `06-companies-table.png` | Another table variant (linked chips, status dots) | §6.3 layout only |
| `07-reminders-table.png` | Tasks table: status icon column, red overdue dates, `All / My` toggle, `Create Task` | §6.4 |
| `08-workspace-menu.png` | Logo click → Settings / Help / Switch workspace | §6.6 entry |
| `09-settings-profile.png` | Profile form layout | §6.6 |
| `10-settings-objects.png` | Settings nav + object card list with counts and chevrons | §6.6 |
| `11-attributes-list.png` | Attribute definitions table: Title, Slug, Type with icon, Created, Updated | §6.7 |
| `12-create-attribute.png` | Create property dialog: Title, Slug helper text, Type, Group, validation error style | §6.7 |
| `13-import-column-mapping.png` | Import step 3: per-column cards, auto-mapped status, value mapping rows, % filled | §6.8 |
| `14-import-review.png` | Import step 4: Find errors, All/Error rows, undo/redo, Find & replace, Export, editable grid | §6.8 |
| `15-contact-detail.png` | Detail page: header, tabs, Highlights cards, Activities list, right attribute sidebar | §6.5 |

---

## 12. Definition of done for Phase 1

Simon can, on his own laptop, with one command: start the app, import his LinkedIn export and Google Contacts without creating duplicates, define his own attributes and see them in the table, filter "Investors in Munich interested in climate tech", open a person, log that he met them, set a follow-up that repeats every quarter, and type a question into the dashboard and get a sensible answer with clickable results. The co-founder can read `docs/ARCHITECTURE.md` and know exactly where to add the Gmail sync and the MCP server. CI is green, `v0.1.0` is tagged.

Now: read the screenshots, ask your questions, and write the plan.
