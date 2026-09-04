import { Building2, CalendarClock, LayoutDashboard, Users, type LucideIcon } from 'lucide-react'

export type NavItem = {
  readonly to: string
  readonly label: string
  readonly icon: LucideIcon
  /** Prefix matching keeps `/contacts` lit on `/contacts/:id`; `/` is a prefix of everything. */
  readonly exact: boolean
}

/**
 * §5.1's navigation, in its order. It is a list rather than four hand-written links because the
 * sidebar renders it twice — expanded with labels, collapsed as an icon rail — and a fifth entry
 * should be one line, not two edits.
 */
export const PRIMARY_NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, exact: true },
  { to: '/contacts', label: 'Contacts', icon: Users, exact: false },
  { to: '/organizations', label: 'Organizations', icon: Building2, exact: false },
  { to: '/follow-ups', label: 'Follow-ups', icon: CalendarClock, exact: false },
] as const satisfies readonly NavItem[]

/** §6.6: `Help & support` points at the repository README. */
export const HELP_URL = 'https://github.com/Kyrillus/mutuals#readme'

export const WORKSPACE_NAME = 'Mutuals'
