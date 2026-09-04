/**
 * The four things a cell needs from outside itself: a locale, a timezone, today's date, and how to
 * build a link to a record.
 *
 * They are context rather than props because a virtualised table renders roughly six hundred cells
 * at a time and none of them should hold a `useQuery` subscription to the profile (ADR-049 puts
 * fetched data in the server cache, read once, not once per cell). They are context rather than
 * module state because the wall clock is an input to `formatRelativeDay`, and injecting it is what
 * makes "3 weeks ago" testable at all (CLAUDE.md, ADR-081).
 *
 * Without a provider the hook falls back to the product's own defaults, recomputed at most once a
 * minute so the object identity is stable inside a render pass. That fallback is deliberately
 * usable rather than a thrown "missing provider": a cell has to render correctly in a test, in a
 * dialog and on a page nobody has wired up yet.
 */
import { todayIn, type CivilDate, type ObjectType } from '@mutuals/core'
import { createContext, useContext, useMemo, type ReactNode } from 'react'

import { useProfile } from '@/hooks/use-profile.ts'

export interface DisplaySettings {
  /** BCP-47. Decides number grouping, month names and the wording of a relative date. */
  readonly locale: string
  /** ADR-045's profile timezone: the only thing that turns an instant into a calendar day. */
  readonly timeZone: string
  readonly today: CivilDate
  readonly now: Date
  /** Where a relation chip points. Stage 3 owns the record detail route and overrides this. */
  readonly recordHref: (objectType: ObjectType, id: string) => string
}

/** `contact` → `/contacts/<id>`. Pluralising the object type is how every list route is spelled. */
export function defaultRecordHref(objectType: ObjectType, id: string): string {
  return `/${objectType}s/${id}`
}

/**
 * The product's language, not the machine's.
 *
 * `navigator.language` would be the obvious default and is the wrong one: the UI is written in
 * English (CLAUDE.md), the profile carries the language the user actually chose (ADR-045), and
 * reading the browser instead would print "vor 2 Monaten" next to an English column header on a
 * German laptop. The timezone is a different question — nobody chooses which hemisphere they are
 * in — so that one *is* taken from the machine until the profile says otherwise.
 */
const DEFAULT_LOCALE = 'en-GB'

function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

const MINUTE = 60_000
let ambient: DisplaySettings | undefined
let ambientMinute = -1

/**
 * The fallback settings, refreshed once a minute. Caching by minute rather than by render keeps
 * the object identity stable long enough to be a safe `useMemo` dependency, while still letting a
 * tab that has been open since yesterday roll over to the new day on its own.
 */
function ambientDisplay(): DisplaySettings {
  const now = new Date()
  const minute = Math.floor(now.getTime() / MINUTE)
  if (ambient === undefined || minute !== ambientMinute) {
    const timeZone = browserTimeZone()
    ambient = {
      locale: DEFAULT_LOCALE,
      timeZone,
      today: todayIn(timeZone, now),
      now,
      recordHref: defaultRecordHref,
    }
    ambientMinute = minute
  }
  return ambient
}

const DisplayContext = createContext<DisplaySettings | null>(null)

export function useDisplay(): DisplaySettings {
  return useContext(DisplayContext) ?? ambientDisplay()
}

/**
 * Puts the profile's language and timezone behind every cell on the page.
 *
 * `overrides` exists for the two callers that legitimately know better: a test that pins `today`,
 * and Stage 3's detail page, which supplies a router-aware `recordHref`.
 */
export function DisplayProvider({
  children,
  overrides,
}: {
  children: ReactNode
  overrides?: Partial<DisplaySettings>
}) {
  const profile = useProfile().data

  const value = useMemo<DisplaySettings>(() => {
    const base = ambientDisplay()
    const timeZone = profile?.timeZone ?? base.timeZone
    return {
      locale: profile?.language ?? base.locale,
      timeZone,
      today: todayIn(timeZone, base.now),
      now: base.now,
      recordHref: base.recordHref,
      ...overrides,
    }
  }, [profile?.language, profile?.timeZone, overrides])

  return <DisplayContext.Provider value={value}>{children}</DisplayContext.Provider>
}
