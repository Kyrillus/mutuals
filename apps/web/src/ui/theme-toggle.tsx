import { LaptopIcon, MoonIcon, SunIcon } from 'lucide-react'

import { useTheme } from '@/hooks/use-theme.ts'
import { isTheme, type Theme } from '@/lib/theme.ts'
import { Button } from '@/ui/button.tsx'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu.tsx'

const OPTIONS = [
  { value: 'light', label: 'Light', Icon: SunIcon },
  { value: 'dark', label: 'Dark', Icon: MoonIcon },
  { value: 'system', label: 'System', Icon: LaptopIcon },
] as const satisfies readonly { value: Theme; label: string; Icon: typeof SunIcon }[]

/**
 * Three states, not two. A two-way toggle cannot express "follow the OS", which is the setting
 * most people actually want and the only one that keeps changing after they walk away.
 *
 * The trigger shows what is currently *on screen* — sun or moon — because that is what the user
 * is looking at; the menu shows which of the three they *chose*, which is the thing they change.
 */
export function ThemeToggle() {
  const { theme, resolvedTheme, setTheme } = useTheme()
  const TriggerIcon = resolvedTheme === 'dark' ? MoonIcon : SunIcon

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={`Theme: ${theme}`}>
          <TriggerIcon aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-36">
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(value) => {
            // Radix's callback is typed `string`. Narrowing it is one line and costs nothing; a
            // cast would put an unchecked value straight into localStorage.
            if (isTheme(value)) setTheme(value)
          }}
        >
          {OPTIONS.map(({ value, label, Icon }) => (
            <DropdownMenuRadioItem key={value} value={value}>
              <Icon aria-hidden />
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
