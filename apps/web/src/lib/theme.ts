/**
 * Light, dark and system — the store behind the theme switcher.
 *
 * Simon asked for both modes, so this supersedes ADR-056's "dark tokens ship but there is no
 * toggle". Three things follow from that, and each one is a decision:
 *
 *   - **A module-level store, not component state.** The switcher and anything else that reacts to
 *     the theme must agree, and `matchMedia` should be listened to once rather than once per
 *     component. `useSyncExternalStore` in `hooks/use-theme.ts` reads this.
 *   - **Every storage access is guarded.** `localStorage` does not merely return `null` in a
 *     locked-down browser, it *throws* on access, and an exception thrown while resolving the
 *     theme would take the whole app down before it rendered.
 *   - **`system` follows the OS live.** A user who changes their appearance setting while Mutuals
 *     is open sees Mutuals change with it; a preference read once at startup is not "system".
 *
 * The class itself is applied to <html> in `index.html`, before first paint, so a dark-mode user
 * never sees a white flash. That code is the authority for the *initial* class; this module is the
 * authority for every change after it. They agree on one storage key and one media query.
 */

export const THEMES = ['light', 'dark', 'system'] as const
export type Theme = (typeof THEMES)[number]

/** The resolved outcome: what `system` actually means right now. */
export type ResolvedTheme = 'light' | 'dark'

/** Shared with the inline script in `index.html`. Changing it here alone reintroduces the flash. */
export const THEME_STORAGE_KEY = 'mutuals.theme'

export const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)'

/** The class `globals.css` declares its `dark` variant against. */
const DARK_CLASS = 'dark'

export function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value)
}

function darkMediaQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  return window.matchMedia(DARK_MEDIA_QUERY)
}

export function systemTheme(): ResolvedTheme {
  return darkMediaQuery()?.matches === true ? 'dark' : 'light'
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  return theme === 'system' ? systemTheme() : theme
}

export function readStoredTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    return isTheme(stored) ? stored : 'system'
  } catch {
    // Private mode, disabled storage, or no window at all. "System" is the honest default.
    return 'system'
  }
}

function writeStoredTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // The preference is lost on reload, which is a smaller failure than a thrown exception.
  }
}

/** Puts the class on <html>, which is the only thing that actually changes what is on screen. */
export function applyResolvedTheme(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle(DARK_CLASS, resolved === 'dark')
}

let current: Theme = readStoredTheme()
let resolved: ResolvedTheme = resolveTheme(current)

// `index.html` has already done this, identically, before first paint. Repeating it costs one
// classList call and means the store is correct on its own terms rather than depending on a
// script in another file staying in sync with it.
applyResolvedTheme(resolved)

const listeners = new Set<() => void>()
let unlistenMedia: (() => void) | null = null

function notify(): void {
  for (const listener of listeners) listener()
}

/**
 * Recomputes and applies. Returns whether anything changed, so the media-query handler can stay
 * silent while the user is on an explicit `light` or `dark` — the OS flipping underneath them is
 * not an event any subscriber needs.
 */
function sync(): boolean {
  const next = resolveTheme(current)
  if (next === resolved) return false
  resolved = next
  applyResolvedTheme(resolved)
  return true
}

function startWatchingSystem(): void {
  const media = darkMediaQuery()
  if (media === null || unlistenMedia !== null) return

  const onChange = (): void => {
    if (sync()) notify()
  }
  media.addEventListener('change', onChange)
  unlistenMedia = () => {
    media.removeEventListener('change', onChange)
  }
}

function stopWatchingSystem(): void {
  unlistenMedia?.()
  unlistenMedia = null
}

export function getTheme(): Theme {
  return current
}

export function getResolvedTheme(): ResolvedTheme {
  return resolved
}

export function setTheme(theme: Theme): void {
  if (theme === current) return
  current = theme
  writeStoredTheme(theme)
  sync()
  notify()
}

/**
 * The listener is attached for the first subscriber and detached with the last, so a page that
 * never renders the switcher does not hold an OS-level subscription.
 */
export function subscribeToTheme(listener: () => void): () => void {
  if (listeners.size === 0) {
    // While nobody was listening there was no `change` event to act on, so the OS may have moved
    // underneath a stale `resolved`. `useSyncExternalStore` re-reads the snapshot after
    // subscribing, which is exactly the window this closes.
    sync()
    startWatchingSystem()
  }
  listeners.add(listener)

  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) stopWatchingSystem()
  }
}

/** Test seam. Nothing in the app calls this; `theme.test.ts` needs a clean store per case. */
export function resetThemeStoreForTests(theme: Theme = 'system'): void {
  stopWatchingSystem()
  listeners.clear()
  current = theme
  resolved = resolveTheme(theme)
}
