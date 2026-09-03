/**
 * The opaque list cursor (ADR-023).
 *
 * Opaque is the point: the default ordering walks `record_list_idx` and pages by keyset, every
 * other ordering pays for a sort and pages by `OFFSET`. Both hide behind one base64url token, so
 * the day the offset variant becomes a keyset walk it is a change to this file and nothing else —
 * no API change, no UI change.
 *
 * There is no signature and no `(filter, sort)` hash inside it. That guards a bug that is
 * unreachable in a single-user app whose only client always sends the filter alongside the cursor,
 * and the mode mismatch that *is* reachable — a cursor from a different sort — is caught by
 * comparing it against the compiled plan.
 */
import { fail, ok, type Result } from '@mutuals/core'
import type { ListPage } from '@mutuals/db'

interface KeysetPayload {
  readonly m: 'k'
  readonly t: string
  readonly i: string
}

interface OffsetPayload {
  readonly m: 'o'
  readonly o: number
}

type Payload = KeysetPayload | OffsetPayload

export function encodeCursor(page: ListPage): string {
  const payload: Payload =
    page.mode === 'keyset' ? { m: 'k', t: page.createdAt, i: page.id } : { m: 'o', o: page.offset }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

export function decodeCursor(raw: string): Result<ListPage> {
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    return fail('malformed_query', 'That cursor is not valid. Start from the first page.', [
      'cursor',
    ])
  }
  if (typeof decoded !== 'object' || decoded === null) {
    return fail('malformed_query', 'That cursor is not valid. Start from the first page.', [
      'cursor',
    ])
  }

  // The union's own discriminant is `'k' | 'o'`, so a `Partial<A & B>` view of it would collapse
  // to `never`. Read the fields as unknown and narrow them one at a time.
  const payload = decoded as { m?: unknown; t?: unknown; i?: unknown; o?: unknown }
  if (payload.m === 'k' && typeof payload.t === 'string' && typeof payload.i === 'string') {
    return ok({ mode: 'keyset', createdAt: payload.t, id: payload.i })
  }
  if (
    payload.m === 'o' &&
    typeof payload.o === 'number' &&
    Number.isInteger(payload.o) &&
    payload.o >= 0
  ) {
    return ok({ mode: 'offset', offset: payload.o })
  }
  return fail('malformed_query', 'That cursor is not valid. Start from the first page.', ['cursor'])
}
