import { ProfileSchema, type Profile } from '@mutuals/core'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'

import { api } from '@/lib/api.ts'
import { qk } from '@/lib/query.ts'

/**
 * The profile is read by the workspace menu and by §6.1's greeting, so it is a hook rather than two
 * copies of the same `useQuery`. `staleTime` is Infinity because the only thing that changes it is
 * Settings → Profile, which invalidates this key itself.
 */
export function useProfile(): UseQueryResult<Profile, Error> {
  return useQuery({
    queryKey: qk.profile(),
    queryFn: ({ signal }) => api.get(ProfileSchema, '/profile', { signal }),
    staleTime: Infinity,
  })
}
