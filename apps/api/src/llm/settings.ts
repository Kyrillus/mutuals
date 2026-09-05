/**
 * `modelFor(kind)` — the database first, the environment second (ADR-064).
 *
 * §3.1 asks that models be swappable **without a deploy**. With only environment variables that
 * sentence means "edit `.env`, then restart the process", which on anything hosted is a deploy —
 * precisely the thing named as the requirement. One row per task kind costs ten lines now and
 * turns §6.6's later Settings page into a form over a row that already exists, rather than a
 * migration plus a form.
 *
 * There is no cache. This is one indexed single-row read on a table with four rows, on a request
 * that is about to spend a second or more talking to a model provider; a cache here would buy
 * nothing and would have to be invalidated by a `psql` update, which is exactly the way this row
 * is expected to be changed today.
 */
import type { Executor } from '@mutuals/db'

import type { Env } from '../env.ts'
import type { TaskKind } from './types.ts'

/** The `llm_setting.key` for each task kind. */
export const MODEL_SETTING_KEYS = {
  extraction: 'model.extraction',
  question: 'model.question',
  summary: 'model.summary',
  embedding: 'model.embedding',
} as const satisfies Record<TaskKind, string>

export function envModelFor(env: Env, kind: TaskKind): string {
  switch (kind) {
    case 'extraction':
      return env.LLM_MODEL_EXTRACTION
    case 'question':
      return env.LLM_MODEL_ANSWER
    case 'summary':
      return env.LLM_MODEL_SUMMARY
    case 'embedding':
      return env.LLM_MODEL_EMBEDDING
  }
}

export async function modelFor(exec: Executor, env: Env, kind: TaskKind): Promise<string> {
  const row = await exec
    .selectFrom('llm_setting')
    .select('value')
    .where('key', '=', MODEL_SETTING_KEYS[kind])
    .executeTakeFirst()

  const override = row?.value.trim() ?? ''
  return override === '' ? envModelFor(env, kind) : override
}

/** Used by the settings row's eventual editor, and by tests that need a known model. */
export async function setModelFor(exec: Executor, kind: TaskKind, model: string): Promise<void> {
  await exec
    .insertInto('llm_setting')
    .values({ key: MODEL_SETTING_KEYS[kind], value: model })
    .onConflict((conflict) =>
      conflict.column('key').doUpdateSet({ value: model, updated_at: new Date() }),
    )
    .execute()
}
