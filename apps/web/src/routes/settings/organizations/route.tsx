import { createFileRoute, Outlet } from '@tanstack/react-router'

/** Carries `Organizations` into the breadcrumb for every settings page below it (§5.1). */
export const Route = createFileRoute('/settings/organizations')({
  component: () => <Outlet />,
  staticData: { crumb: 'Organizations' },
})
