import { createFileRoute, Outlet } from '@tanstack/react-router'

/** Carries `Contacts` into the breadcrumb for every settings page below it (§5.1). */
export const Route = createFileRoute('/settings/contacts')({
  component: () => <Outlet />,
  staticData: { crumb: 'Contacts' },
})
