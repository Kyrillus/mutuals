# Handover

Written so a session that has never seen this project can pick it up without asking anything. If you
are that session: read `CLAUDE.md` first, then this file, then start.

Everything that matters is on disk. Nothing load-bearing lives only in a chat transcript — that was
the point of `docs/DECISIONS.md` being kept current from the first commit. This file holds the small
remainder: where the work stopped, what the environment expects, and how the two people want to be
talked to.

---

## Where the work stopped

**Stages 1, 2 and 3 are done. Stage 4 is half done** — follow-ups and the dashboard have landed;
saved views are what remains. Everything lives in
[PR #1](https://github.com/Kyrillus/mutuals/pull/1), which grew to cover them together and was
retitled — see ADR-089 for why, and why that was Simon's call rather than a default.

|           |                                                                                        |
| --------- | -------------------------------------------------------------------------------------- |
| Section 1 | App shell, router, API client, design tokens in light and dark, theme switcher         |
| Section 2 | The shared `DataTable`, the two per-type registries, the filter bar, the contacts page |
| Section 3 | Settings navigation, the attributes list, the create/edit attribute dialog             |
| Section 4 | Playwright e2e, the keyboard pass, the third CI job                                    |

**Stage 3** added the organizations table and detail page, contact↔organization links through the
UI, §6.5's contact detail page with its four tabs, interactions CRUD, and §4.5's value-history
popover — the first screen that reads the append-only log.

**Stage 4, session A** added §6.4's follow-ups — the page with its quick-filter tabs, create/edit,
mark done, snooze, and the Follow-ups tab on a contact — plus §6.1's dashboard: the four stat cards,
"Needs your attention" and the recently-interacted list. Q6 is answered and shipped (ADR-093).

`pnpm verify` is green: 1,160 unit tests, 311 integration tests, lint, typecheck and build clean.
`pnpm verify:e2e` is green: 14 specs, 1 `fixme` (the LinkedIn import, Stage 5).

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

Still open, none of them blocking, all in `docs/DECISIONS.md` §14 with a recommendation:
**Q4** (what is preselected for a near-certain duplicate in the import review grid — Stage 5).
**Q6 is answered**: ADR-093, and it is built.

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

Four traps that already cost time once each, all now guarded but worth knowing:

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
- **Radix tabs and popovers do not respond to synthetic `.click()`.** Driving the app through
  `javascript_tool` will silently fail on them; Playwright sends real pointer events and does not.
  Verify anything tab- or popover-shaped through the e2e suite rather than through the dev console.

## The next step, verbatim

Paste this as the first message of the new session:

> Read `CLAUDE.md`, then `docs/HANDOFF.md`, then `docs/BRIEF.md` §5.2 and §6.6.
>
> Build **Stage 4, session B — saved views**, which closes the stage.
>
> A view is a named set of visible columns, their order, filters and sort (§5.2, §6.6). Most of the
> machinery exists and the job is mostly reconciliation, not construction:
>
> 1. **The working copy is already in the URL** (ADR-047), and `retainSearchParams(['view'])` already
>    carries `?view=` through every navigation (ADR-048). `serializeListQuery` is already canonical
>    and ADR-048 already says dirtiness is deep equality over exactly its output — so there is one
>    canonicalisation to compare against, not two.
> 2. **The operations are already named**: `listViews`, `createView`, `updateView`, `deleteView` sit
>    in `PLANNED_OPERATIONS` in `apps/api/src/routes/operations.ts`. Move them to `OPERATIONS` rather
>    than inventing names — `operations.test.ts` asserts the two arrays stay disjoint.
> 3. **What is missing** is persistence, the `⋮` menu of §5.2 (`Save changes to view`, `Save as new
view`, `Revert changes`, `Table settings`), and the breadcrumb reading `Contacts › Investors in
Munich`. §6.2 also names four seeded views, and the seed already creates five contact views and
>    one organization view — check what is there before adding more.
> 4. **The hard part is the state machine**, and it is worth designing before typing: the URL holds a
>    working copy, the saved view holds a baseline, and the UI has to say which is showing, whether
>    they differ, and what each menu item does in each case. Get that on paper first.
> 5. **`routes/settings/-components/table-views.tsx`** is currently an empty state explaining that
>    views are Stage 4. It is where the management screen goes.
>
> Closing the stage: update `docs/PLAN.md`, `CLAUDE.md`'s stage marker and `README.md`, then retitle
> PR #1 and rewrite its body to cover Stages 1–4. Everything is on `version/claude-v1` and therefore
> in PR #1 (ADR-089). **Still do not merge it.**
>
> Verify by running things, not by reading them. `pnpm verify:full` is the gate. Report back in the
> two layers §0 requires.

## How the two people want to be talked to

Brief §0, and it is not decoration — it is the thing most easily dropped under time pressure.

**Simon** is the product owner and is not a developer. Plain language, short sentences, concrete
examples, no file paths and no code in his layer. He asks good, sharp questions about cost and about
whether a thing actually works; answer them with numbers you measured, not impressions.

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
