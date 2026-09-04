# Handover

Written so a session that has never seen this project can pick it up without asking anything. If you
are that session: read `CLAUDE.md` first, then this file, then start.

Everything that matters is on disk. Nothing load-bearing lives only in a chat transcript — that was
the point of `docs/DECISIONS.md` being kept current from the first commit. This file holds the small
remainder: where the work stopped, what the environment expects, and how the two people want to be
talked to.

---

## Where the work stopped

**Stages 1 to 4 are done.** Everything lives in
[PR #1](https://github.com/Kyrillus/mutuals/pull/1), which grew to cover them together and was
retitled — see ADR-089 for why, and why that was Simon's call rather than a default.

**Stage 1** built the engine: migrations, the fact log and its projector, the attribute registry,
the filter compiler, the API and the seed. **Stage 2** built the app shell in light and dark, the one
shared `DataTable` with its filter bar and inline editing, Settings → Attributes, and the Playwright
suite with the third CI job.

**Stage 3** added the organizations table and detail page, contact↔organization links through the
UI, §6.5's contact detail page with its four tabs, interactions CRUD, and §4.5's value-history
popover — the first screen that reads the append-only log.

**Stage 4** added §6.4's follow-ups — the page with its quick-filter tabs, create/edit, mark done,
snooze, and the Follow-ups tab on a contact — §6.1's dashboard, and §6.6's saved views. Q6 is
answered and shipped (ADR-093); ADR-094 records what building views settled.

`pnpm verify` is green: 1,160 unit tests, 311 integration tests, lint, typecheck and build clean.
`pnpm verify:e2e` is green: **18 specs — 17 run, 1 `fixme`**. That one is the LinkedIn import, and it
is exactly what Stage 5 turns into a real test.

**Do not merge PR #1.** `main` has moved on — another session built a getmutuals.ai waitlist site in
`site/`, which this branch never touches. Merging PR #1 today would delete the old German Next.js
prototype from `main`, and Simon's instruction was to leave it there. The only real conflict is two
lines of `.gitignore`. Simon has said explicitly: **do nothing about it.** Revisit at Stage 7.
Retitling the PR and rewriting its body is not merging, and ADR-089 records that he asked for it.

## What only existed in the chat, and now exists here

These are Simon's decisions, made in conversation. The first three are also recorded as answered
questions in `docs/DECISIONS.md` §14; they are repeated here because they are easy to violate.

- **Ignore `main` completely.** Nothing is ported from the old prototype — not code, not fixtures,
  not the ~1,128 contacts in its local SQLite file. That file sits untracked in `data/` and is not
  referenced by anything on this branch. There is no SQLite→Postgres migration and none is planned.
- **`asks` / `offers` stay `tags`-typed**, per §4.1 — but **always carry the date**. That is free:
  each tag element is a fact with `valid_from`, and removing one writes a superseding fact rather
  than a delete, so "asking since June 2025" and "stopped asking in March 2026" are both recorded.
  Show the since-date inline on those two attributes, not only in the history popover.
- **Both light and dark mode ship**, with a three-state switcher (light / dark / system, following
  the OS live). This supersedes ADR-056's "dark tokens ship but there is no toggle", and it is why
  `apps/web/src/styles/contrast.test.ts` exists — it found a real failure when it was written.
- **Simon has approved how the app looks.** He ran it and said so. Do not redesign the shell.
- **Bugs go to him the moment he finds one, not in a batch** (asked and answered 2026-09-04). His
  reasoning is the right one: a collected bug has lost its context by the time anybody reads it. The
  agreement in return is that _trivial_ fixes happen on the spot, and anything needing a design
  choice is brought to him rather than decided quietly.
- **One stage, one session.** Each stage — and for a large one, each half — starts a fresh chat with
  the prompt below. That is why this file has to be complete: it is the only thing that crosses the
  gap. If something matters and lives only in a transcript, it is lost.

**One question is still open, and it is not needed until Stage 6:** **Q7** — the LLM daily spending
cap defaults to **$2.00/day** and nobody has confirmed that number. Ask when the LLM layer starts,
not before. Everything Stage 5 needs is settled.

**Q4** (Simon, 2026-09-04): a near-certain duplicate is **not** silently pre-decided.
The row is flagged and the user is asked in as many words — _"this looks like a contact you already
have: do you really want to import it?"_ — with **not importing** as the default. That is option (a)
of §14 plus an explicit prompt rather than a silent skip. **Q6 is answered** too: ADR-093, built.

**Two small things found by Simon clicking around, neither blocking:**

- **Fixed, but without a regression test.** A popover opened inside a dialog could not be scrolled
  with the wheel: Radix's Dialog locks scrolling with `react-remove-scroll`, which allows wheel
  events only inside its own subtree, and every popover portalled to `document.body`. Dialogs now
  publish their content node (`useDialogContainer`) and the four portalling popovers render into it.
  A spec was attempted and abandoned because the Type control has no stable accessible name — see
  the next point. **Worth writing once that is fixed.**
- **The Type and Group controls are buttons with no programmatic label.** `FieldRow` renders a
  `<label for>`, which names form controls and not buttons, so their accessible name is their
  current _value_ ("Short text") rather than "Type". Harmless on screen, wrong for a screen reader,
  and it is what made the regression test above brittle.

## Documents that are part of every stage's definition of done

§8.3 names them; this is the operational version, with what enforces each.

| File                   | Keep current with                                          | Guarded by                              |
| ---------------------- | ---------------------------------------------------------- | --------------------------------------- |
| `README.md`            | Status line, stage count, ADR count                        | nothing — read it                       |
| `CLAUDE.md`            | Stage marker, commands, conventions                        | nothing — read it                       |
| `docs/PLAN.md`         | The stage table's status column                            | nothing — read it                       |
| `docs/DECISIONS.md`    | One ADR per decision not covered by the brief              | nothing — read it                       |
| `docs/HANDOFF.md`      | This file, rewritten at the end of every stage             | nothing — read it                       |
| `docs/ARCHITECTURE.md` | Data flow, extension points, measured latencies            | nothing — read it                       |
| `docs/openapi.json`    | **Regenerated with `pnpm openapi`** after any route change | `openapi.test.ts` fails the build       |
| `docs/ERRORS.md`       | An anchor for every error `type` URI the API can return    | `errors.test.ts` fails the build        |
| `.env.example`         | Every variable any package reads                           | `env.test.ts` compares it to the schema |

The last three fail CI if you forget. The first six do not, which is exactly why they are the ones
that rot — and why this file gets rewritten rather than appended to.

## The environment, exactly

macOS. Node 24.20.0. Postgres runs in Docker.

```bash
corepack enable pnpm          # once. The composite verify scripts call `pnpm` themselves,
                              # so without this they fail with "command not found".
# Neither Homebrew's bin nor Docker Desktop's is on the default PATH of a non-interactive shell
# here, so node, pnpm, docker and gh all read as "command not found" until this line runs.
export PATH="/opt/homebrew/bin:$HOME/.docker/bin:$PATH"
pnpm install
pnpm dev                      # database up, migrated, API on :3001, web on :3000
pnpm seed                     # 200 contacts, 60 organizations, 500 interactions, 40 follow-ups
pnpm verify                   # what CI runs
```

```bash
pnpm --filter @mutuals/e2e exec playwright install chromium   # once, ~95 MB
pnpm verify:e2e               # build, migrate mutuals_e2e, Playwright
pnpm verify:full              # verify + verify:e2e
```

Traps that already cost time once each, all now guarded but worth knowing:

- **`localhost` resolves to `::1` here, and half the tooling polls `127.0.0.1`.** Two servers can
  both "succeed" on port 3000 — one on IPv6, one on IPv4 — and neither errors. This is why
  `vite.config.ts`'s `preview` block binds `127.0.0.1` explicitly, and it is the first thing to
  suspect whenever something is listening and nothing can reach it.
- **`process.loadEnvFile` and `--env-file` do not override a variable already in the environment.**
  A wrapper that exports `PORT` wins over `.env` silently, and the API ends up on the wrong port.
- **`vite build` ships React's development JSX runtime** unless `NODE_ENV=production` is set _before_
  Vite is imported. Not from Vite's build mode, not from the config function — the plugin reads it at
  import time. `apps/web/scripts/build.mjs` handles it and asserts its own output.
- **`pnpm db:check`** generates 10,000 contacts × 60 attributes and takes about 80 seconds. It is the
  performance harness, not part of `verify`.
- **`page.clock` pins the browser's clock only.** The API keeps its own, so anything the server
  derives — a follow-up's `state`, the date of a recurrence's next occurrence — is still computed
  against the real today. Asserting a literal server-derived date in an e2e spec asserts what day
  the machine thinks it is. ADR-091 has the corrected version; a test found this the hard way.
- **A view's snapshot is the _effective_ columns, not the URL's.** The URL omits `columns` while the
  table shows its defaults, so reading it straight saves a view with no columns that is dirty the
  instant it is created. ADR-094 has the detail; it is the kind of thing that looks fine until a
  test asserts it.
- **Radix tabs and popovers do not respond to synthetic `.click()`.** Driving the app through
  `javascript_tool` will silently fail on them; Playwright sends real pointer events and does not.
  Verify anything tab- or popover-shaped through the e2e suite rather than through the dev console.

## The next step, verbatim

Paste this as the first message of the new session:

> Read `CLAUDE.md`, then `docs/HANDOFF.md`, then `docs/BRIEF.md` §6.8, §6.9 and §4.6.
>
> Build **Stage 5 — the import wizard, duplicate detection and merge**. It is the largest stage left
> and splits cleanly in two; do the first half, stop, and report.
>
> **Session A — the wizard and what lands.** §6.8's five steps: upload, map columns, fix errors in
> an editable grid, review, commit. `import_batch` and `import_row` exist from migration 0005 and
> nothing has touched them. `PLANNED_OPERATIONS` holds **eleven** reserved names: eight for the
> import (`createImportBatch` … `getImportErrorReport`) and three for merge (`mergeContacts`,
> `previewMergeContacts`, `mergeOrganizations`), which belong to session B. Move them into
> `OPERATIONS` as you implement them rather than inventing names — `operations.test.ts` asserts the
> two arrays stay disjoint, so a name in both fails the build.
> `fixtures/linkedin_connections_sample.csv` and `google_contacts_sample.csv` are the fixtures, and
> the LinkedIn one has three preamble lines before its header on purpose.
>
> **Session B — duplicates and merge.** §4.6's identity matching already exists and is unit-tested
> in `packages/core`: exact on a normalised identifier is near-certain, name similarity is only ever
> the fallback. §6.9's merge UI is the new part. **Q4 is already answered — do not ask it again:**
> a near-certain duplicate is flagged and the user is asked in as many words ("this looks like a
> contact you already have — do you really want to import it?"), with _not importing_ as the
> default. Same outcome as §14's option (a), but stated as a question so the person sees why the row
> did not land. `docs/DECISIONS.md` §14 has it verbatim.
>
> **`e2e/specs/import-linkedin-csv.spec.ts` is the acceptance test** and it is already written, as
> `fixme`, with the numbers it expects and why: the fixture holds two deliberate collisions, one
> exact-identifier and one diacritic-fold. Changing an assertion is allowed; say why in the PR body.
>
> Everything goes on `version/claude-v1` and therefore into PR #1 (ADR-089). **Still do not merge it.**
>
> **Closing the stage**, after session B and not before: `docs/PLAN.md`'s stage table, `CLAUDE.md`'s
> stage marker, `README.md`'s status and ADR count, `docs/HANDOFF.md` rewritten for Stage 6 — then
> retitle PR #1 and rewrite its body to cover Stages 1–5, keeping the "Scope note" block at the top.
> Session A ends with green CI and commits pushed, and leaves the stage markers alone.
>
> Verify by running things, not by reading them. `pnpm verify:full` is the gate. Report back in the
> two layers §0 requires, and stop for approval.

## How the two people want to be talked to

Brief §0, and it is not decoration — it is the thing most easily dropped under time pressure.

**Simon** is the product owner and is not a developer. Plain language, short sentences, concrete
examples, no file paths and no code in his layer. He asks good, sharp questions about cost and about
whether a thing actually works; answer them with numbers you measured, not impressions.

**He writes in German about as often as in English, and switches mid-thread.** Answer his layer in
whichever language he last used. This does **not** change CLAUDE.md's rule that the repository is
English throughout — code, comments, docs, commit messages and UI stay English no matter what
language the conversation is in. The technical layer is for his co-founder and stays English.

He is also worth arguing with productively: twice he pushed back on something ("does that make the
app slow?", "are you sure the handover is complete?") and was right both times — the first forced a
measurement, the second found six errors in this file.

**His co-founder** is a senior engineer who reviews architecture. Give him the trade-off, the thing
you are unsure about, and what would falsify the decision.

Both layers, every time. When a decision is not covered by the brief: small and reversible, pick the
simplest option and add an ADR; large or hard to reverse, stop and ask.

## One habit worth keeping

Everything good in this repo came from checking rather than trusting. The projection-equivalence gate
found a real bug on its first run. The schema drift test was _proved_ to fail before it was believed.
The performance harness turned "deleting a contact is fast" into "deleting a contact took 4.0
seconds" and then into 1.03 ms. The contrast test found a grey that was unreadable on grey.

None of those were found by reading code. Keep running the thing.
