import { createFileRoute, Outlet } from '@tanstack/react-router'

import { SettingsNav } from './-components/settings-nav.tsx'

/**
 * §6.6's settings shell: its own left nav beside the page, and `Settings` in front of every crumb
 * below it — so `/settings/contacts/attributes` reads `Settings › Contacts › Attributes` (§5.1)
 * without any child knowing where it sits.
 */
export const Route = createFileRoute('/settings')({
  component: SettingsLayout,
  staticData: { crumb: 'Settings' },
})

function SettingsLayout() {
  return (
    <div className="flex items-start gap-8">
      <SettingsNav />
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  )
}
