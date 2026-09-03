/**
 * Phase 1 has exactly one workspace (ADR-014 keeps the column so multi-tenancy is a filter rather
 * than a migration), so every write resolves the id rather than making twenty call sites carry it.
 */
import { WriteError, type Executor } from './types.ts'

export async function resolveWorkspaceId(exec: Executor, given?: string | null): Promise<string> {
  if (given != null) return given
  const row = await exec
    .selectFrom('workspace')
    .select('id')
    .orderBy('created_at')
    .limit(1)
    .executeTakeFirst()
  if (row === undefined) throw new WriteError('no workspace row; run the migrations first')
  return row.id
}
