# Handover

Written so a session that has never seen this project can pick it up without asking anything. If you
are that session: read `CLAUDE.md` first, then this file, then start.

Everything that matters is on disk. Nothing load-bearing lives only in a chat transcript — that was
the point of `docs/DECISIONS.md` being kept current from the first commit. This file holds the small
remainder: where the work stopped, what the environment expects, and how the two people want to be
talked to.

---

## Where the work stopped

**Stages 1 to 5 are done.** Everything lives in
[PR #1](https://github.com/Kyrillus/mutuals/pull/1), which grew to cover them together and was
retitled — see ADR-089 for why, and why that was Simon's call rather than a default.

**Stage 1** built the engine: migrations, the fact log and its projector, the attribute registry,
the filter compiler, the API and the seed. **Stage 2** built the app shell in light and dark, the one
shared `DataTable` with its filter bar and inline editing, Settings → Attributes, and the Playwright
suite with the third CI job. **Stage 3** added the organizations table and detail page,
contact↔organization links through the UI, §6.5's contact detail page with its four tabs,
interactions CRUD, and §4.5's value-history popover. **Stage 4** added §6.4's follow-ups, §6.1's
dashboard and §6.6's saved views.

**Stage 5** added §6.8's import wizard and §6.9's merge. The wizard reads CSV and XLSX, finds a
header row under LinkedIn's preamble, auto-maps columns through ADR-044's seven-step cascade, stages
every row server-side, detects duplicates against existing records **and within the file itself**,
and commits in chunks through a pg-boss job. Merge moves the loser's facts onto the survivor rather
than deleting them. `PLANNED_OPERATIONS` is now **empty**: every operation ADR-031 enumerated in
Stage 1 is registered.

`pnpm verify` is green: **1,259 unit tests, 416 integration tests** (plus one skipped on purpose —
see R7 below), lint, typecheck and build clean. `pnpm verify:e2e` is green: **21 specs, all
running.** The LinkedIn import spec that sat `fixme` from Stage 1 is real.

**Do not merge PR #1.** `main` has moved on — another session built a getmutuals.ai waitlist site in
`site/`, which this branch never touches. Merging PR #1 today would delete the old German Next.js
prototype from `main`, and Simon's instruction was to leave it there. The only real conflict is two
lines of `.gitignore`. Simon has said explicitly: **do nothing about it.** Revisit at Stage 7.

## What Stage 5 changed that reaches beyond Stage 5

Three things a Stage 6 session will meet and should not rediscover.

- **ADR-099 moved the duplicate-matching thresholds, for the whole product.** `FUZZY_NAME_THRESHOLD`
  was 0.75, unjustified and uncommented since Stage 1; it is now **0.65**, on measured evidence in
  the ADR. A separate `NAME_CANDIDATE_THRESHOLD` of 0.45 governs which records enter the pool at
  all — using one number for both had made `name_initial_org_same` dead code in production, because
  "J. Weber" scores 0.5385 against "Jonas Weber" and the candidate never arrived. Quick capture
  (§4.8) calls the same matcher, so it inherits both.
- **`name_exact_city_same` cannot fire from any path that would have to name the city attribute by
  slug.** Populating `cityKey` means asking for "the city attribute", and a seeded attribute the
  user may rename or delete is exactly what the one rule forbids naming. Closing it needs a declared
  _semantic marker_ on attribute definitions — a real Stage 6+ conversation, not a bug.
- **pg-boss is live, in-process by default (ADR-062).** `MUTUALS_WORKER=off` on the API plus
  `apps/worker` is the whole scale-out path. Four of ADR-058's assumptions about its API were wrong
  and are corrected in code with comments; the one that bites hardest is that `singletonKey`
  deduplicates nothing unless the queue is created `stately`.

## What only existed in the chat, and now exists here

These are Simon's decisions, made in conversation. The first three are also recorded as answered
questions in `docs/DECISIONS.md` §14; they are repeated here because they are easy to violate.

- **Ignore `main` completely.** Nothing is ported from the old prototype — not code, not fixtures,
  not the ~1,128 contacts in its local SQLite file. There is no SQLite→Postgres migration and none
  is planned.
- **`asks` / `offers` stay `tags`-typed**, per §4.1 — but **always carry the date**. Show the
  since-date inline on those two attributes, not only in the history popover.
- **Both light and dark mode ship**, with a three-state switcher (light / dark / system, following
  the OS live). This supersedes ADR-056's "dark tokens ship but there is no toggle".
- **Simon has approved how the app looks.** He ran it and said so. Do not redesign the shell.
- **Bugs go to him the moment he finds one, not in a batch.** A collected bug has lost its context
  by the time anybody reads it. In return, _trivial_ fixes happen on the spot and anything needing a
  design choice is brought to him.
- **One stage, one session.** Each stage — and for a large one, each half — starts a fresh chat with
  the prompt below. Stage 5 was run as two halves in one session and it worked, but only because
  every decision was written to `docs/DECISIONS.md` before the build rather than after.

**One question is still open and Stage 6 is where it lands: Q7** — the LLM daily spending cap
defaults to **$2.00/day** and nobody has confirmed that number. **Ask it in the first message of the
Stage 6 session**, not later: it is the one input the LLM layer cannot be built without agreeing.

**Q4 is answered and built** (Simon, 2026-09-04): a flagged duplicate is not silently pre-decided.
The row is flagged and the user asked in as many words — _"this looks like a contact you already
have: do you really want to import it?"_ — with **not importing** as the default. The Review grid
words the two kinds of duplicate differently, because "you already have this contact" and "this file
lists this person twice" are different problems.

**Three small things worth knowing, none blocking:**

- **A popover inside a dialog was fixed without a regression test.** Radix's Dialog locks scrolling
  with `react-remove-scroll`; dialogs now publish their content node (`useDialogContainer`) and the
  four portalling popovers render into it. The spec was abandoned because the Type control has no
  stable accessible name — see the next point. **Worth writing once that is fixed.**
- **The Type and Group controls in the attribute editor are buttons with no programmatic label.**
  `FieldRow` renders a `<label for>`, which names form controls and not buttons, so their accessible
  name is their current _value_ ("Short text") rather than "Type". Harmless on screen, wrong for a
  screen reader, and it is what made the regression test above brittle. Ten minutes.
- **Apple Contacts vCard is deferred** (ADR-096) and shows in the wizard's dropdown disabled. It is
  not merely unbuilt work: a vCard is a stream of records with repeating typed fields rather than a
  grid, so §6.8's one-card-per-column mapping UI has no obvious meaning for it.

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
pnpm verify:full              # ...all three
```

Traps that already cost time once each, all now guarded but worth knowing:

- **`localhost` resolves to `::1` here, and half the tooling polls `127.0.0.1`.** Two servers can
  both "succeed" on port 3000 — one on IPv6, one on IPv4 — and neither errors. This is why
  `vite.config.ts`'s `preview` block binds `127.0.0.1` explicitly.
- **`process.loadEnvFile` and `--env-file` do not override a variable already in the environment.**
- **`vite build` ships React's development JSX runtime** unless `NODE_ENV=production` is set _before_
  Vite is imported. `apps/web/scripts/build.mjs` handles it and asserts its own output.
- **`pnpm db:check`** generates 10,000 contacts × 60 attributes and takes about 80 seconds. It is the
  performance harness, not part of `verify`.
- **`page.clock` pins the browser's clock only.** Anything the server derives is still computed
  against the real today. ADR-091 has the corrected version.
- **A view's snapshot is the _effective_ columns, not the URL's.** ADR-094 has the detail.
- **Radix tabs, menus and popovers do not respond to synthetic `.click()`.** Driving the app through
  `javascript_tool` silently fails on them; Playwright sends real pointer events and does not. The
  merge spec is the one that proves this — its `⋯` menu opens nowhere else.
- **`pg` serialises a JS array as a Postgres array literal, not as JSON.** Every jsonb write goes
  through `JSON.stringify`, which is what `views.ts` and `imports.ts` both do.
- **`jsonb_set` creates only the _last_ element of its path.** Writing `{edits, 3}` on a row with no
  `edits` key returns the row unchanged — no error, and an `UPDATE … RETURNING` reporting success.
  Cost an hour in Stage 5; only an assertion on the resulting value found it.

## The next step, verbatim

Paste this as the first message of the new session:

> Read `CLAUDE.md`, then `docs/HANDOFF.md`, then `docs/BRIEF.md` §4.8, §6.1, §6.5, §6.10 and §9, and
> `docs/DECISIONS.md` §7 (the LLM ADRs, 064 to 072) plus §16.
>
> Build **Stage 6 — the LLM layer and the command palette**. It splits in two; do the first half,
> stop, and report.
>
> **Ask Q7 in your first reply and wait for the answer.** `LLM_DAILY_COST_LIMIT_USD` defaults to
> $2.00/day and nobody has confirmed it. It is the one input this stage cannot be built without
> agreeing, and `docs/DECISIONS.md` §14 has the framing. Everything else Stage 6 needs is settled.
>
> **Session A — the LLM module and `ask`.** The provider client, the prompt registry, the cost cap,
> the `llm_call` audit table (migration 0006, untouched since Stage 1) and §4.8's "ask the network":
> a natural-language question becomes a **structured filter over the existing API**, runs, and the
> answer shows _which filter it ran_ so the user can trust or correct it. `search`, `ask` and
> `quickCapture` are already registered and answer 501 with their real request and response shapes
> in `docs/openapi.json` — fill them in rather than inventing new operations. ADR-064 to ADR-072
> cover the module; ADR-068's replayable trace is a Postgres table and its fixtures are files.
>
> **Session B — quick capture, summaries and the palette.** §4.8's quick capture (free text in, an
> editable preview of contact + organization + interaction + follow-up out, nothing saved before
> confirmation), §6.5's on-demand summary, and §6.10's ⌘K command palette over §4.8's global search.
> Quick capture matches people through the **same** `matchDuplicates` the importer uses — ADR-099
> moved its thresholds in Stage 5 and quick capture inherits them, which is intended.
>
> The LLM extracts and code decides (§4.8). Nothing the model returns is written without validation,
> and nothing is written at all before the user confirms it.
>
> Everything goes on `version/claude-v1` and therefore into PR #1 (ADR-089). **Still do not merge it.**
>
> **Closing the stage**, after session B and not before: `docs/PLAN.md`'s stage table, `CLAUDE.md`'s
> stage marker, `README.md`'s status and ADR count, `docs/HANDOFF.md` rewritten for Stage 7 — then
> retitle PR #1 and rewrite its body to cover Stages 1–6, keeping the "Scope note" block at the top.
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

He is also worth arguing with productively: three times now he has pushed back on something ("does
that make the app slow?", "are you sure the handover is complete?", "how much is left?") and been
right each time — the first forced a measurement, the second found six errors in this file, the
third produced an honest split of what was done from what was not.

**His co-founder** is a senior engineer who reviews architecture. Give him the trade-off, the thing
you are unsure about, and what would falsify the decision.

Both layers, every time. When a decision is not covered by the brief: small and reversible, pick the
simplest option and add an ADR; large or hard to reverse, stop and ask.

## One habit worth keeping

Everything good in this repo came from checking rather than trusting. The projection-equivalence gate
found a real bug on its first run. The performance harness turned "deleting a contact is fast" into
"deleting a contact took 4.0 seconds" and then into 1.03 ms. The contrast test found a grey that was
unreadable on grey.

Stage 5 is the clearest case so far. Reading the handover against the code found four errors in it
before a line was written — including an acceptance test whose every number was wrong. Measuring the
matching threshold against real name pairs found three duplicates the old setting could not detect.
And of the bugs the build itself produced, **three were completely silent**: a `jsonb_set` that
reported success and did nothing, a test double that modelled a queue wrongly and deadlocked, and a
hard-coded empty array that disabled two matching rules without failing anything.

None of those were found by reading code. Keep running the thing.
