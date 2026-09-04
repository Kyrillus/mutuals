import { createFileRoute, Outlet } from '@tanstack/react-router'

/**
 * The layout that puts `Contacts` in front of every crumb below it, so the detail page reads
 * `Contacts › Anna Berger` (§5.1) without knowing where it sits. It renders nothing of its own —
 * the table and the detail page are both full pages.
 */
export const Route = createFileRoute('/contacts')({
  component: Outlet,
  staticData: { crumb: 'Contacts' },
})
