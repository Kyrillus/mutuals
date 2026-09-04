import { Link } from '@tanstack/react-router'
import { PanelLeft, PanelLeftClose } from 'lucide-react'

import { cn } from '@/lib/utils.ts'

import { GlobalSearch } from './global-search.tsx'
import { PRIMARY_NAV } from './navigation.ts'
import { WorkspaceMenu } from './workspace-menu.tsx'

/**
 * §5.1: ~240px, light grey, workspace name → search → navigation, collapsible. Collapsed it becomes
 * an icon rail rather than disappearing, which is what the reference does and what keeps the
 * navigation reachable in one click instead of two.
 */
export function Sidebar({
  collapsed,
  onToggle,
  onExpand,
}: {
  collapsed: boolean
  onToggle: () => void
  onExpand: () => void
}) {
  return (
    <aside
      className={cn(
        'bg-sidebar text-sidebar-foreground border-sidebar-border flex shrink-0 flex-col border-r',
        collapsed ? 'w-sidebar-collapsed' : 'w-sidebar',
      )}
    >
      <div className={cn('flex items-center gap-1 p-2', collapsed && 'flex-col')}>
        <WorkspaceMenu collapsed={collapsed} />
        <button
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground grid size-7 shrink-0 place-items-center rounded-md"
        >
          {collapsed ? <PanelLeft className="size-4" /> : <PanelLeftClose className="size-4" />}
        </button>
      </div>

      <div className={cn('px-2 pb-2', collapsed && 'flex justify-center')}>
        <GlobalSearch collapsed={collapsed} onExpand={onExpand} />
      </div>

      <nav aria-label="Main" className="flex flex-col gap-0.5 px-2">
        {PRIMARY_NAV.map((item) => {
          const Icon = item.icon
          return (
            <Link
              key={item.to}
              to={item.to}
              activeOptions={{ exact: item.exact }}
              activeProps={{
                className: 'bg-sidebar-accent text-sidebar-accent-foreground font-medium',
                'aria-current': 'page',
              }}
              inactiveProps={{ className: 'text-muted-foreground' }}
              title={collapsed ? item.label : undefined}
              className={cn(
                'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground flex h-8 items-center gap-2.5 rounded-md text-sm',
                collapsed ? 'justify-center px-0' : 'px-2',
              )}
            >
              <Icon className="size-4 shrink-0" />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </Link>
          )
        })}
      </nav>
    </aside>
  )
}
