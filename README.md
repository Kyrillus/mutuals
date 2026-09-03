# Mutuals

**Mutuals — the personal people CRM for the agentic era.** · getmutuals.ai

A tool for founders, investors, operators and community builders to keep track of everyone they know — with an agent inside that knows your whole network.

Ask it things like:

> "I just met a health-tech founder in Munich who is raising €600k. Which investors in my network would be a fit?"

## Why another CRM?

Most CRMs are built for sales teams. This one is built for a person and their network.

- **Proactive.** It reminds you to stay in touch with the right people and suggests introductions between people who need each other.
- **Effortless.** After a meeting, type one sentence. The system turns it into a contact, a note and a follow-up.
- **Yours to shape.** Define your own attributes and table views. Import from LinkedIn, Google Contacts or any spreadsheet without duplicates.
- **Agent-ready.** Everything the UI can do, the API can do. An MCP server, a chat bot and a CLI are just more clients.

## Status

**Pre-alpha. Stage 1 of 7 is done: the engine runs and is documented. No user interface yet — that is Stage 2.**

- [`docs/BRIEF.md`](./docs/BRIEF.md) — the product specification: data model, every screen, the build
  plan. The source of truth for product decisions. Reference screenshots in [`docs/refs/`](./docs/refs).
- [`docs/PLAN.md`](./docs/PLAN.md) — the implementation plan, in two layers: a plain summary and the
  technical detail.
- [`docs/DECISIONS.md`](./docs/DECISIONS.md) — the architecture decision log, 83 records.
  `docs/adr-archive/` keeps the reasoning trail, including the designs that were rejected.

### Running it

```bash
corepack enable pnpm     # once; pnpm ships with Node but is not on PATH by default
pnpm install
pnpm dev                 # starts the database, migrates it, runs the API
pnpm seed                # ~200 contacts, 60 organizations, 500 interactions, 40 follow-ups
```

`pnpm dev` needs a Postgres 16 with `pgvector` and `pg_trgm`. It starts one in Docker if Docker is
there, and otherwise prints the two other ways to get one (Postgres.app, Homebrew) rather than
installing anything itself. The API documents itself at `/api/docs`.

`pnpm verify` is what CI runs. Screenshots and a roadmap land here as the interface is built.

## Built with

TypeScript · Postgres 16 with `pgvector` · Fastify · Kysely · React · Tailwind CSS · shadcn/ui ·
TanStack Table · Vite · Zod · Vitest · Playwright. One command to run it locally; MIT throughout.
The full stack, and the reasoning for each choice, is in [`docs/PLAN.md`](./docs/PLAN.md).

## Licence

MIT
