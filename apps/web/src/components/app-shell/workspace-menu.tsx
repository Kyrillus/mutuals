import { Link } from '@tanstack/react-router'
import {
  ArrowLeftRight,
  ChevronsUpDown,
  LifeBuoy,
  Monitor,
  Moon,
  Settings,
  Sun,
  type LucideIcon,
} from 'lucide-react'

import { useProfile } from '@/hooks/use-profile.ts'
import { useTheme } from '@/hooks/use-theme.ts'
import { isTheme, THEMES, type Theme } from '@/lib/theme.ts'
import { cn } from '@/lib/utils.ts'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu.tsx'

import { HELP_URL, WORKSPACE_NAME } from './navigation.ts'

const THEME_OPTION: Record<Theme, { label: string; icon: LucideIcon }> = {
  light: { label: 'Light', icon: Sun },
  dark: { label: 'Dark', icon: Moon },
  system: { label: 'System', icon: Monitor },
}

/**
 * §6.6's entry point: the workspace name top-left opens Settings and Help & support. The theme
 * switch lives here too, rather than in a corner of its own — it is a preference, it is used twice
 * a year, and the alternative is a permanent control in a shell §5.1 wants calm.
 */
export function WorkspaceMenu({ collapsed }: { collapsed: boolean }) {
  const { theme, setTheme } = useTheme()
  const profile = useProfile()
  const fullName =
    profile.data === undefined
      ? null
      : `${profile.data.firstName} ${profile.data.lastName}`.trim() || null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'hover:bg-sidebar-accent flex min-w-0 items-center gap-2 rounded-md py-1.5 outline-none',
          collapsed ? 'justify-center px-1' : 'flex-1 px-1.5',
        )}
        aria-label={`${WORKSPACE_NAME} — workspace menu`}
      >
        <span className="bg-sidebar-primary text-sidebar-primary-foreground grid size-6 shrink-0 place-items-center rounded-[5px] text-xs font-semibold">
          {WORKSPACE_NAME.slice(0, 1)}
        </span>
        {!collapsed && (
          <>
            <span className="truncate text-sm font-semibold">{WORKSPACE_NAME}</span>
            <ChevronsUpDown className="text-muted-foreground ml-auto size-3.5 shrink-0" />
          </>
        )}
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" sideOffset={6} className="min-w-60">
        <div className="flex items-center gap-2.5 px-2 py-1.5">
          <span className="bg-muted text-muted-foreground grid size-8 shrink-0 place-items-center rounded-full text-xs font-semibold">
            {initials(fullName)}
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{fullName ?? WORKSPACE_NAME}</div>
            <div className="text-muted-foreground truncate text-xs">
              {profile.data?.email ?? 'Personal workspace'}
            </div>
          </div>
        </div>

        <DropdownMenuSeparator />

        <DropdownMenuItem asChild>
          <Link to="/settings">
            <Settings className="text-muted-foreground" />
            Settings
          </Link>
        </DropdownMenuItem>

        <DropdownMenuItem asChild>
          <a href={HELP_URL} target="_blank" rel="noreferrer">
            <LifeBuoy className="text-muted-foreground" />
            Help &amp; support
          </a>
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuLabel className="text-muted-foreground text-xs font-medium">
          Theme
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(value) => {
            if (isTheme(value)) setTheme(value)
          }}
        >
          {THEMES.map((option) => {
            const Icon = THEME_OPTION[option].icon
            return (
              <DropdownMenuRadioItem key={option} value={option}>
                <Icon className="text-muted-foreground" />
                {THEME_OPTION[option].label}
              </DropdownMenuRadioItem>
            )
          })}
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />

        {/* §6.6 says a greyed-out placeholder is fine: several workspaces are §9, not Phase 1. */}
        <DropdownMenuItem disabled>
          <ArrowLeftRight />
          Switch workspace
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function initials(name: string | null): string {
  if (name === null) return WORKSPACE_NAME.slice(0, 1)
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.slice(0, 1).toUpperCase())
    .join('')
}
