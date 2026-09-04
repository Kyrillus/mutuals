import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ThemeModule from './theme.ts'

/**
 * The unit project runs in `node`, so there is no DOM. Rather than pull in jsdom for four
 * assertions, the three browser surfaces this module actually touches are faked here — which has
 * the side benefit that the storage failure mode can be provoked directly, and that is the one
 * that takes the whole app down if it is not handled.
 */

interface FakeMedia {
  matches: boolean
  emitChange: () => void
  listenerCount: () => number
}

function fakeMatchMedia(initiallyDark: boolean): {
  media: FakeMedia
  matchMedia: (query: string) => MediaQueryList
} {
  const listeners = new Set<() => void>()
  let matches = initiallyDark

  const media: FakeMedia = {
    get matches() {
      return matches
    },
    set matches(value: boolean) {
      matches = value
    },
    emitChange: () => {
      for (const listener of [...listeners]) listener()
    },
    listenerCount: () => listeners.size,
  }

  const matchMedia = (): MediaQueryList =>
    ({
      get matches() {
        return matches
      },
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    }) as unknown as MediaQueryList

  return { media, matchMedia }
}

interface Harness {
  media: FakeMedia
  /** What `document.documentElement.classList` ended up holding. */
  isDark: () => boolean
  storage: Map<string, string>
}

function install({
  systemDark = false,
  stored,
  storageThrows = false,
}: { systemDark?: boolean; stored?: string; storageThrows?: boolean } = {}): Harness {
  const { media, matchMedia } = fakeMatchMedia(systemDark)
  const storage = new Map<string, string>()
  if (stored !== undefined) storage.set('mutuals.theme', stored)

  const classes = new Set<string>()

  vi.stubGlobal('window', {
    matchMedia,
    localStorage: {
      getItem: (key: string) => {
        if (storageThrows) throw new Error('The operation is insecure.')
        return storage.get(key) ?? null
      },
      setItem: (key: string, value: string) => {
        if (storageThrows) throw new Error('The operation is insecure.')
        storage.set(key, value)
      },
    },
  })

  vi.stubGlobal('document', {
    documentElement: {
      classList: {
        toggle: (name: string, force: boolean) => {
          if (force) classes.add(name)
          else classes.delete(name)
        },
      },
    },
  })

  return { media, isDark: () => classes.has('dark'), storage }
}

/** The module reads storage at import time, so every case gets a fresh copy of it. */
async function load(): Promise<typeof ThemeModule> {
  vi.resetModules()
  return import('./theme.ts')
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the stored preference', () => {
  it('starts from what localStorage holds', async () => {
    install({ stored: 'dark' })
    const theme = await load()

    expect(theme.getTheme()).toBe('dark')
    expect(theme.getResolvedTheme()).toBe('dark')
  })

  it('falls back to system when the stored value is not one of the three', async () => {
    install({ stored: 'midnight', systemDark: true })
    const theme = await load()

    expect(theme.getTheme()).toBe('system')
    expect(theme.getResolvedTheme()).toBe('dark')
  })

  it('survives storage that throws on access', async () => {
    // Safari in Lockdown Mode and Firefox with cookies blocked both throw here rather than
    // returning null, which is why every access is wrapped.
    install({ storageThrows: true, systemDark: true })
    const theme = await load()

    expect(theme.getTheme()).toBe('system')
    expect(theme.getResolvedTheme()).toBe('dark')
    expect(() => {
      theme.setTheme('light')
    }).not.toThrow()
    expect(theme.getTheme()).toBe('light')
  })

  it('persists a choice and puts the class on the root element', async () => {
    const harness = install()
    const theme = await load()
    theme.setTheme('dark')

    expect(harness.storage.get('mutuals.theme')).toBe('dark')
    expect(harness.isDark()).toBe(true)
  })
})

describe('system mode', () => {
  it('follows the OS while the app is open', async () => {
    // The point of the whole store: a preference read once at startup is not "system".
    const harness = install({ stored: 'system', systemDark: false })
    const theme = await load()

    const seen: string[] = []
    theme.subscribeToTheme(() => seen.push(theme.getResolvedTheme()))

    harness.media.matches = true
    harness.media.emitChange()

    expect(seen).toEqual(['dark'])
    expect(theme.getResolvedTheme()).toBe('dark')
    expect(harness.isDark()).toBe(true)
  })

  it('stays quiet while an explicit theme is chosen', async () => {
    const harness = install({ stored: 'light', systemDark: false })
    const theme = await load()

    const seen: string[] = []
    theme.subscribeToTheme(() => seen.push(theme.getResolvedTheme()))

    harness.media.matches = true
    harness.media.emitChange()

    expect(seen).toEqual([])
    expect(theme.getResolvedTheme()).toBe('light')
  })

  it('picks up the OS state that changed while nobody was subscribed', async () => {
    const harness = install({ stored: 'dark', systemDark: true })
    const theme = await load()

    harness.media.matches = false
    theme.setTheme('system')

    expect(theme.getResolvedTheme()).toBe('light')
    expect(harness.isDark()).toBe(false)
  })

  it('catches up on the first subscription', async () => {
    // No listener is attached until someone subscribes, so an OS change in that window arrives as
    // no event at all. Subscribing has to re-resolve rather than trust the last known value.
    const harness = install({ stored: 'system', systemDark: false })
    const theme = await load()

    harness.media.matches = true
    expect(theme.getResolvedTheme()).toBe('light')

    theme.subscribeToTheme(() => {})

    expect(theme.getResolvedTheme()).toBe('dark')
    expect(harness.isDark()).toBe(true)
  })
})

describe('subscriptions', () => {
  it('holds exactly one OS listener, and only while someone is listening', async () => {
    const harness = install({ stored: 'system' })
    const theme = await load()

    expect(harness.media.listenerCount()).toBe(0)

    const first = theme.subscribeToTheme(() => {})
    const second = theme.subscribeToTheme(() => {})
    expect(harness.media.listenerCount()).toBe(1)

    first()
    expect(harness.media.listenerCount()).toBe(1)

    second()
    expect(harness.media.listenerCount()).toBe(0)
  })

  it('notifies every subscriber when the preference changes', async () => {
    install()
    const theme = await load()

    const seen: string[] = []
    theme.subscribeToTheme(() => seen.push(`a:${theme.getTheme()}`))
    theme.subscribeToTheme(() => seen.push(`b:${theme.getTheme()}`))

    theme.setTheme('dark')
    // Setting the same value again is not a change and must not wake anyone.
    theme.setTheme('dark')

    expect(seen).toEqual(['a:dark', 'b:dark'])
  })
})

describe('isTheme', () => {
  it('accepts the three states and nothing else', async () => {
    install()
    const theme = await load()

    expect(theme.THEMES.every((value) => theme.isTheme(value))).toBe(true)
    expect(theme.isTheme('Dark')).toBe(false)
    expect(theme.isTheme(null)).toBe(false)
    expect(theme.isTheme(undefined)).toBe(false)
  })
})
