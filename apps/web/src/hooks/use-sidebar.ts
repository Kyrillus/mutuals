import { useCallback, useState } from 'react'

/**
 * Deliberately the same namespace as `mutuals.theme`, which `index.html` reads before first paint.
 * Two keys, one prefix, so clearing the app's local state is one obvious sweep.
 */
const STORAGE_KEY = 'mutuals.sidebar-collapsed'

function readStored(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true'
  } catch {
    // Private mode, or storage disabled. An expanded sidebar is the right default anyway.
    return false
  }
}

export type SidebarState = {
  collapsed: boolean
  toggle: () => void
  expand: () => void
}

/**
 * §5.1: the sidebar is collapsible and the choice sticks. This is component state (ADR-049's third
 * home) with a write-through to `localStorage`; it is a per-browser preference, not data, so it has
 * no business in the server cache or the URL.
 */
export function useSidebar(): SidebarState {
  const [collapsed, setCollapsed] = useState(readStored)

  const write = useCallback((next: boolean) => {
    setCollapsed(next)
    try {
      localStorage.setItem(STORAGE_KEY, String(next))
    } catch {
      // The sidebar still collapses; only the memory of it is lost.
    }
  }, [])

  const toggle = useCallback(() => {
    write(!collapsed)
  }, [collapsed, write])

  const expand = useCallback(() => {
    write(false)
  }, [write])

  return { collapsed, toggle, expand }
}
