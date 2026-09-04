import { useSyncExternalStore } from 'react'

import {
  getResolvedTheme,
  getTheme,
  setTheme,
  subscribeToTheme,
  type ResolvedTheme,
  type Theme,
} from '@/lib/theme.ts'

export interface UseThemeResult {
  /** What the user chose: `light`, `dark` or `system`. This is what the switcher ticks. */
  theme: Theme
  /** What `system` currently resolves to. This is what is on screen. */
  resolvedTheme: ResolvedTheme
  setTheme: (theme: Theme) => void
}

/**
 * `useSyncExternalStore` rather than `useState` + `useEffect`: the preference lives outside React
 * (it is a class on <html> and a row in localStorage), several components read it, and the OS can
 * change it while nobody is interacting. That is the exact shape this hook is for.
 *
 * Both snapshots are strings, so there is no cached-object identity to get wrong.
 */
export function useTheme(): UseThemeResult {
  const theme = useSyncExternalStore(subscribeToTheme, getTheme, getTheme)
  // No server renders this app, but the third argument is what keeps the hook from throwing if one
  // ever does. Light is the pre-hydration assumption `index.html` also starts from.
  const serverSnapshot = (): ResolvedTheme => 'light'
  const resolvedTheme = useSyncExternalStore(subscribeToTheme, getResolvedTheme, serverSnapshot)

  return { theme, resolvedTheme, setTheme }
}
