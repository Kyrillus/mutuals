/**
 * §6.6: "Settings has its own left nav: Account → Profile; Objects → Contacts, Organizations."
 *
 * It is a column inside the settings pages rather than a replacement for the app's own sidebar,
 * which stays where it is: `10-settings-objects.png` shows a product whose settings are a separate
 * place you leave the app to visit, and this one is a page you are still inside the app on — the
 * breadcrumb keeps reading `Settings › Contacts › Attributes` and one click returns to Contacts.
 */
import { Link } from '@tanstack/react-router'
import { UserRoundIcon, LayersIcon, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { SETTINGS_OBJECTS } from './objects.ts'

export function SettingsNav() {
  return (
    <nav aria-label="Settings" className="w-48 shrink-0">
      <Section icon={UserRoundIcon} title="Account">
        <NavLink to="/settings/profile" label="Profile" />
      </Section>

      <Section icon={LayersIcon} title="Objects">
        {SETTINGS_OBJECTS.map((object) => (
          <NavLink key={object.to} to={object.to} label={object.label} />
        ))}
      </Section>
    </nav>
  )
}

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon
  title: string
  children: ReactNode
}) {
  return (
    <div className="mb-5">
      <p className="text-muted-foreground mb-1.5 flex items-center gap-2 px-2 text-xs font-medium">
        <Icon className="size-3.5" />
        {title}
      </p>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  )
}

function NavLink({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      // Prefix matching, so `/settings/contacts/attributes` keeps Contacts lit while the
      // breadcrumb carries the rest of the path.
      activeProps={{
        className: 'bg-accent text-accent-foreground font-medium',
        'aria-current': 'page',
      }}
      inactiveProps={{ className: 'text-muted-foreground' }}
      className="hover:bg-accent hover:text-accent-foreground flex h-8 items-center rounded-md px-2 text-sm"
    >
      <span className="truncate">{label}</span>
    </Link>
  )
}
