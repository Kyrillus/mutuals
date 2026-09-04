/**
 * From the URL's list query to the API's query string.
 *
 * A separate module from the hook that uses it because it is pure and worth testing on its own:
 * everything else about a list request — the cache key, the page walk — is decided by what this
 * function returns.
 */
import { serializeListQuery, type ListQuery } from '@mutuals/core'

/**
 * The parameters that actually change the answer.
 *
 * Two are dropped. `view` names the saved view the URL was opened from (ADR-048) and the API has
 * no opinion about it. `columns` is dropped **unless there is a `?q=`**: the API reads it only to
 * scope the substring search, so keeping it would turn hiding a column into a network request and
 * throw away every loaded page for a change the server cannot see.
 */
export function requestParams(query: ListQuery): Record<string, string> {
  const serialized = serializeListQuery({ ...query, cursor: null, limit: null })
  const { view: _view, ...rest } = serialized
  if (rest['q'] === undefined) delete rest['columns']
  return rest
}
