# Handover

Written so a session that has never seen this project can pick it up without asking anything. If you
are that session: read `CLAUDE.md` first, then this file, then start.

Everything that matters is on disk. Nothing load-bearing lives only in a chat transcript — that was
the point of `docs/DECISIONS.md` being kept current from the first commit. This file holds the small
remainder: where the work stopped, what the environment expects, and how the two people want to be
talked to.

---

## Where the work stopped

**Stages 1 to 6 are done. Stage 7 is part-done and paused mid-flight** — see "Stage 7, where it
actually stands" below before doing anything else. Everything lives in
[PR #1](https://github.com/Kyrillus/mutuals/pull/1), which grew to cover them together and has been
retitled at each stage — see ADR-089 for why, and why that was Simon's call rather than a default.

**Stage 1** built the engine: migrations, the fact log and its projector, the attribute registry,
the filter compiler, the API and the seed. **Stage 2** built the app shell in light and dark, the one
shared `DataTable` with its filter bar and inline editing, Settings → Attributes, and the Playwright
suite with the third CI job. **Stage 3** added the organizations table and detail page,
contact↔organization links through the UI, §6.5's contact detail page with its four tabs,
interactions CRUD, and §4.5's value-history popover. **Stage 4** added §6.4's follow-ups, §6.1's
dashboard and §6.6's saved views. **Stage 5** added §6.8's import wizard and §6.9's merge.

**Stage 6 added the LLM layer and the palette**, in two halves. The first built
`apps/api/src/llm/` — a task client over an OpenAI-compatible port, a hand-written transport whose
total deadline is created once _before_ the retry loop, strict `json_schema` that is always
re-validated with one repair round-trip, prompts as versioned modules under a lock file, the
`llm_call` trace, and the daily cost cap checked immediately before **every** billable POST — plus
§4.8's "ask the network". The second added §4.8's quick capture, §6.5's on-demand summary, §4.8's
global search and §6.10's ⌘K palette.

`pnpm verify` is green: **1,339 unit tests** (2 skipped on purpose — ADR-072's live smoke test and
the live half of the prompt-lock check, both skipping loudly with their reasons) and **489
integration tests** (1 skipped — ADR-095's pooler test, §13's R7), lint, typecheck and build clean.
`pnpm verify:e2e` is green: **30 specs.** The run prints these; do not trust a number in a document
over one you just measured.

**Do not merge PR #1.** `main` has moved on — another session built a getmutuals.ai waitlist site in
`site/`, which this branch never touches. Merging PR #1 today would delete the old German Next.js
prototype from `main`, and Simon's instruction was to leave it there. The only real conflict is two
lines of `.gitignore`. Simon has said explicitly: **do nothing about it.** Revisit at Stage 7.

## Stage 7, where it actually stands

Paused deliberately, not abandoned: Simon's 5-hour limit was about to run out and stopping at a green
gate was better than stopping anywhere. `pnpm verify` and `pnpm verify:e2e` both pass right now —
**53 e2e specs pass and 4 are `test.fixme`** — so the tree is safe to build on.

**Done in Stage 7 so far**

- `docs/screenshots/` and `pnpm screenshots`, which regenerates all five against a seeded database
  rather than leaving pictures to rot. The README embeds them.
- The README rewritten for release: what it looks like, how to run it, how to import a LinkedIn
  export, how to turn the AI on, and two rules for contributors.
- An accessibility and keyboard pass across the attribute editor's controls (the Type and Group
  labels that were owed since Stage 3 are done), plus **23 new e2e specs**, taking the suite from 30
  to 57.

**The four defects, which are the most valuable thing here**

`e2e/specs/api-unreachable.spec.ts` covers what the app does when Fastify is not running — the case
Simon will actually meet, and the one every existing error test misses, because those all assume the
API answers. The agent that wrote it **measured each failure before simulating it**, and its file
header records what the app really showed. Four tests are `test.fixme` because the defects are still
there:

| Test                                                                 | The defect                                                                                                                |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `a table whose schema cannot be fetched says so, and recovers`       | Renders `The field definitions could not be loaded: 502 Bad Gateway` — a raw status string, on screen, to a non-developer |
| `the dashboard admits it has no numbers instead of loading for ever` | Stat cards pulse indefinitely; there is no failure state                                                                  |
| `an edit that fails on the way out is rolled back, and says why`     | The rollback works; the toast still carries the transport error rather than a sentence                                    |
| `a write that hangs is given up on rather than left pending`         | Nothing gives up. There is no client-side deadline on a write                                                             |

Note the shape of these: the app handles a server that _answers badly_ well, and a server that is
_absent_ poorly. Fix them one at a time and remove the `fixme` as each lands.

**Not started**

- The sweep across every empty state (§5.2 asks for one per table, per filtered-to-nothing view, per
  record with no children). The seeded database hides most of them, so they have to be created.
- The speed pass. `docs/ARCHITECTURE.md` §4's numbers are from Stage 1 and describe a schema three
  migrations ago; `pnpm db:check` re-measures them in about 80 seconds. **The import, merge and
  nightly-sweep paths have never been measured at 10,000 rows** — §13's R5 predicts 8–20 s for the
  import and nobody has checked.
- `CLAUDE.md`'s closing pass and the `v0.1.0` tag.

**The two things only Simon can settle**

1. **The OpenRouter key.** `llm_call` has zero rows: no model has ever answered. The wiring is
   tested against a fake provider and the daily cap is enforced, but §12's acceptance test — "type a
   question into the dashboard and get a sensible answer" — cannot be ticked until a real key is set
   and someone tries it. This is the one gap between "the tests pass" and "the product works".
2. **`main`.** This is the stage where the merge question is due. `main` carries the old German
   prototype and a `site/` directory this branch has never touched; the only real conflict is two
   lines of `.gitignore`. His standing instruction has been "do nothing about it" — bring him the
   options, do not pick one.

## What Stage 6 changed that reaches beyond Stage 6

Five things a Stage 7 session will meet and should not rediscover.

- **ADR-071's import rule is live and asserted.** `apps/api/src/llm/**` may be imported by
  `routes/ask.ts`, `routes/quick-capture.ts`, `routes/summary.ts`, `main.ts`, `bin/**`,
  `test-support/**` and test files — **and nothing else**, by exact path. `boundary.test.ts` runs
  the real ESLint over both directions. Adding a fourth route that calls a model means adding it to
  `eslint.config.js` deliberately, which is the point.
- **The prompt lock is enforced.** Editing any prompt fails CI until `pnpm llm:relock` is run and the
  diff committed (ADR-067, ADR-114). Three prompts are locked. Bump `version` when the _meaning_
  changes; relock when only the wording does.
- **The cost cap is checked before every billable POST**, not once per task, and its window is the
  profile's civil day derived in SQL (ADR-105). `GET /api/v1/stats/llm` reports the cap, today's
  spend and the breakdown. A measured question costs about **$0.0009** on `openai/gpt-4.1-mini`
  (~1,560 prompt tokens against the seeded schema), so $5.00 is roughly 5,800 questions a day.
- **`PLANNED_OPERATIONS` and `PLANNED_PROMPTS` are both empty.** Every name is registered. The arrays
  stay because the tests that keep them disjoint from the registered lists are the guard that made
  them worth keeping.
- **Nothing returns 501 any more.** `notImplemented()` and its `docs/ERRORS.md` anchor stay, because
  publishing a shape before fitting the engine is how this API introduces an operation, and the next
  one will use it again. `ERRORS.md` says so rather than claiming three routes still answer it.

## What only existed in the chat, and now exists here

These are Simon's decisions, made in conversation. The first three are also recorded as answered
questions in `docs/DECISIONS.md` §14; they are repeated here because they are easy to violate.

- **Ignore `main` completely.** Nothing is ported from the old prototype — not code, not fixtures,
  not the ~1,128 contacts in its local SQLite file. There is no SQLite→Postgres migration and none
  is planned.
- **`asks` / `offers` stay `tags`-typed**, per §4.1 — but **always carry the date**.
- **Both light and dark mode ship**, with a three-state switcher (light / dark / system, following
  the OS live). This supersedes ADR-056's "dark tokens ship but there is no toggle".
- **Simon has approved how the app looks.** He ran it and said so. Do not redesign the shell.
- **Bugs go to him the moment he finds one, not in a batch.** In return, _trivial_ fixes happen on
  the spot and anything needing a design choice is brought to him.
- **One stage, one session.** Each stage — and for a large one, each half — starts a fresh chat.

**There are no open questions.** §14 is empty. Q7 was the last one, answered 2026-09-05: the LLM
daily cap is $5.00.

**Three things Simon has to do before the AI features work on his machine**, none of them code:

1. **`OPENROUTER_API_KEY` is empty in his `.env`.** Without it the three agent routes answer 503 and
   the dashboard says so on the input; everything else works. A key from openrouter.ai/keys is the
   whole fix.
2. **His `.env` still says `LLM_DAILY_COST_LIMIT_USD=2.00`**, written before he answered $5.00.
3. **His `.env` predates the new LLM block.** The new keys (`LLM_MODE`, the two timeouts,
   `LLM_TRACE_BODIES`, the embedding settings) all have defaults, so nothing breaks — but copying the
   block out of `.env.example` is worth doing while he is in there.

## Three small things worth knowing, none blocking

- **A popover inside a dialog was fixed without a regression test** (Stage 3). Radix's Dialog locks
  scrolling with `react-remove-scroll`; dialogs publish their content node (`useDialogContainer`) and
  the four portalling popovers render into it. The spec was abandoned because the Type control has no
  stable accessible name — see the next point. **Worth writing once that is fixed.**
- **The Type and Group controls in the attribute editor are buttons with no programmatic label.**
  `FieldRow` renders a `<label for>`, which names form controls and not buttons, so their accessible
  name is their current _value_ ("Short text") rather than "Type". Harmless on screen, wrong for a
  screen reader. Ten minutes.
- **Apple Contacts vCard is deferred** (ADR-096) and shows in the wizard's dropdown disabled. A vCard
  is a stream of records with repeating typed fields rather than a grid, so §6.8's one-card-per-column
  mapping UI has no obvious meaning for it.

## Documents that are part of every stage's definition of done

§8.3 names them; this is the operational version, with what enforces each.

| File                                 | Keep current with                                            | Guarded by                              |
| ------------------------------------ | ------------------------------------------------------------ | --------------------------------------- |
| `README.md`                          | Status line, stage count, ADR count                          | nothing — read it                       |
| `CLAUDE.md`                          | Stage marker, commands, conventions                          | nothing — read it                       |
| `docs/PLAN.md`                       | The stage table's status column                              | nothing — read it                       |
| `docs/DECISIONS.md`                  | One ADR per decision not covered by the brief                | nothing — read it                       |
| `docs/HANDOFF.md`                    | This file, rewritten at the end of every stage               | nothing — read it                       |
| `docs/ARCHITECTURE.md`               | Data flow, extension points, measured latencies              | nothing — read it                       |
| `docs/openapi.json`                  | **Regenerated with `pnpm openapi`** after any route change   | `openapi.test.ts` fails the build       |
| `docs/ERRORS.md`                     | An anchor for every error `type` URI the API can return      | `errors.test.ts` fails the build        |
| `apps/api/src/llm/prompts.lock.json` | **Regenerated with `pnpm llm:relock`** after any prompt edit | `lock.test.ts` fails the build          |
| `.env.example`                       | Every variable any package reads                             | `env.test.ts` compares it to the schema |

The last four fail CI if you forget. The first six do not, which is exactly why they are the ones
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
- **Radix tabs, menus and popovers do not respond to synthetic `.click()`.** Playwright sends real
  pointer events and does not. The merge spec is the one that proves this.
- **A global keyboard shortcut is not live until React has mounted.** `page.goto` resolves before the
  effect that registers it has run, so pressing ⌘K straight after a navigation delivers a real
  keydown to nothing — which fails as "the palette never opened" and looks exactly like a broken
  shortcut. `palette-and-capture.spec.ts` waits for the shell's search control first.
- **`pg` serialises a JS array as a Postgres array literal, not as JSON.** Every jsonb write goes
  through `JSON.stringify`.
- **`jsonb_set` creates only the _last_ element of its path.** Cost an hour in Stage 5; only an
  assertion on the resulting value found it.
- **A backtick inside a `` sql`…` `` template ends the template.** The house comment style writes
  `` `mutuals_norm` `` in prose and that closes the string. Caught twice in one file in Stage 6.
- **An uncast parameter in `$1 is null` fails at prepare time**, and Postgres's message points
  nowhere near the predicate. `::uuid` fixes it; the symptom is every query in the file 500ing.
- **A string replacement that matches nothing reports success.** Prettier reformats files between
  edits, so a patch written against the pre-format text silently applies half of itself — the import
  lands, the code it was for does not. Stage 6 lost two rounds to this; the defence is a test written
  before the fix, and re-reading the file rather than trusting the edit.

## The next step, verbatim

Paste this as the first message of the new session:

> Read `CLAUDE.md`, then `docs/HANDOFF.md`, then `docs/BRIEF.md` §11 and §12, and the whole of
> `docs/DECISIONS.md` §13 (the risk register).
>
> Build **Stage 7 — polish and `v0.1.0`**. §10's own list: empty states, the keyboard pass, a speed
> pass at 10,000 rows, screenshots in the README, and the version bump. §12 is the definition of
> done and is the thing to work down.
>
> **Nothing needs asking first.** §14 has no open questions.
>
> Three things are already written down as owed work and should be done rather than rediscovered:
> the attribute editor's Type and Group controls have no programmatic label (ten minutes, and it is
> what made a Stage-3 regression test too brittle to keep — write that test once it is fixed); §13's
> **R7** is still open and closes the moment `POOLER_DATABASE_URL` is set (ADR-095); and
> `docs/ARCHITECTURE.md` §4's measured numbers predate Stages 5 and 6, so the speed pass should
> re-run `pnpm db:check` and update them rather than quoting them.
>
> **PR #1 and `main`.** This is the stage where the merge question is finally due. `main` carries the
> old German Next.js prototype and a `site/` directory this branch has never touched; the only real
> conflict is two lines of `.gitignore`. Simon's standing instruction has been "do nothing about it"
> — so bring him the options rather than picking one.
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

He is also worth arguing with productively: several times now he has pushed back on something ("does
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
unreadable on grey. Stage 5 found four bugs by running the thing, three of them silent.

**Stage 6's clearest case is a claim that had been true and had stopped being true.** ADR-069 chose
OpenRouter for embeddings on the strength of a live check in Stage 1 — "37 embedding models are
listed". Re-run in Stage 6, the same endpoint returns 431 models and **not one** embedding model. The
only reason anybody knows is that the check was re-run instead of quoted. Nothing broke, because
nothing calls `embed()` yet; the default moved to the fallback ADR-069 itself had named, and ADR-106
records the re-measurement rather than the conclusion.

The second-clearest is smaller and more embarrassing: a fix that was written, reported as applied,
and had silently matched nothing. It was caught in under a minute — because the regression test had
been written _before_ the fix. That ordering is the whole lesson.

None of these were found by reading code. Keep running the thing.
