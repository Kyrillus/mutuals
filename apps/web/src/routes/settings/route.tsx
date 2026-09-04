import { createFileRoute, Outlet } from '@tanstack/react-router'

/**
 * A layout route with nothing but an outlet — its whole job is to put `Settings` in front of every
 * crumb below it, so `/settings/profile` reads `Settings › Profile` (§5.1) without either child
 * knowing where it sits.
 */
export const Route = createFileRoute('/settings')({
  component: SettingsLayout,
  staticData: { crumb: 'Settings' },
})

function SettingsLayout() {
  return <Outlet />
}
