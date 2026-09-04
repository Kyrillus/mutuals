# Handover

Written so a session that has never seen this project can pick it up without asking anything. If you
are that session: read `CLAUDE.md` first, then this file, then start.

Everything that matters is on disk. Nothing load-bearing lives only in a chat transcript — that was
the point of `docs/DECISIONS.md` being kept current from the first commit. This file holds the small
remainder: where the work stopped, what the environment expects, and how the two people want to be
talked to.

---

## Where the work stopped

**Stage 1 — Foundation: done.** Green CI, [PR #1](https://github.com/Kyrillus/mutuals/pull/1).
**Stage 2 — Contacts table + attributes: sections 1–3 of 4 done.**

|               |                                                                                        |
| ------------- | -------------------------------------------------------------------------------------- |
| Section 1     | App shell, router, API client, design tokens in light and dark, theme switcher         |
| Section 2     | The shared `DataTable`, the two per-type registries, the filter bar, the contacts page |
| Section 3     | Settings navigation, the attributes list, the create/edit attribute dialog             |
| **Section 4** | **Not started.** Playwright e2e, empty-state and keyboard pass, then the Stage 2 PR    |

`pnpm verify` is green: 1,150 unit tests, 311 integration tests, lint, typecheck and build clean.

**Do not merge PR #1.** `main` has moved on — another session built a getmutuals.ai waitlist site in
`site/`, which this branch never touches. Merging PR #1 today would delete the old German Next.js
prototype from `main`, and Simon's instruction was to leave it there. The only real conflict is two
lines of `.gitignore`. Simon has said explicitly: **do nothing about it.** Revisit at Stage 7.

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
**Q4** (what is preselected for a near-certain duplicate in the import review grid — Stage 5),
**Q6** (the nightly warmth sweep on a laptop that is asleep at 03:30 — Stage 4).

## The environment, exactly

macOS. Node 24.20.0. Postgres runs in Docker.

```bash
corepack enable pnpm          # once. The composite verify scripts call `pnpm` themselves,
                              # so without this they fail with "command not found".
export PATH="$HOME/.docker/bin:$PATH"   # Docker Desktop is not on the default PATH here
pnpm install
pnpm dev                      # database up, migrated, API on :3001, web on :3000
pnpm seed                     # 200 contacts, 60 organizations, 500 interactions, 40 follow-ups
pnpm verify                   # what CI runs
```

Two traps that already cost time once each, both now guarded but worth knowing:

- **`vite build` ships React's development JSX runtime** unless `NODE_ENV=production` is set _before_
  Vite is imported. Not from Vite's build mode, not from the config function — the plugin reads it at
  import time. `apps/web/scripts/build.mjs` handles it and asserts its own output.
- **`pnpm db:check`** generates 10,000 contacts × 60 attributes and takes about 80 seconds. It is the
  performance harness, not part of `verify`.

## The next step, verbatim

Paste this as the first message of the new session:

> Read `CLAUDE.md`, then `docs/HANDOFF.md`, then `docs/BRIEF.md` §5.2, §6.2 and §8.1.
>
> Build **Stage 2, section 4**, which closes the stage:
>
> 1. **Playwright end-to-end tests** for the four flows §8.1 names, as far as the built features
>    allow: create an attribute → it appears as a column → filter by it; create a contact → it
>    appears in the table; a saved-view round trip through the URL. The interaction and follow-up
>    flows arrive in Stages 3 and 4 — write them as `test.fixme` with the intended assertions rather
>    than skipping them silently. `e2e/` does not exist yet; ADR-079 and `docs/DECISIONS.md` §8
>    describe how it is wired and how it seeds. Add the third CI job that runs `verify:e2e`.
> 2. **An empty-state and keyboard pass** over what exists: every table and page has a real empty
>    state with a call to action; tab order is sane; the sticky column and the dialogs are reachable
>    without a mouse.
> 3. **Update the docs** — `docs/PLAN.md`'s stage table, `CLAUDE.md`'s stage marker, and
>    `README.md`'s status — then open the Stage 2 PR against `main` **without merging it**, in the
>    shape of PR #1: plain summary, technical detail, how to try it, a definition-of-done checklist.
>
> Verify by running things, not by reading them. An agent's self-report is not evidence: the browser
> and the database are. Report back in the two layers §0 requires.

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
