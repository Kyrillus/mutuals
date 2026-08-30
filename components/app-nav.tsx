'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

import { openCommandPalette } from '@/lib/ui-events';
import { cx, IconSearch, Kbd } from '@/components/ui';

/**
 * Die Navigation der Kopfzeile.
 *
 * Der aktive Punkt wird ueber Textfarbe und einen 2px-Balken am unteren Rand
 * markiert, nicht ueber einen gefuellten Knopf. Der Balken sitzt auf der
 * Trennlinie der Kopfzeile (-bottom-px), er ersetzt sie also optisch an dieser
 * Stelle, statt darueber zu schweben.
 */
interface NavItem {
  href: string;
  label: string;
  /** Pfade, die diesen Punkt ebenfalls aktiv machen. */
  extraPrefixes?: string[];
}

const ITEMS: NavItem[] = [
  { href: '/', label: 'Liste', extraPrefixes: ['/contacts'] },
  { href: '/board', label: 'Board' },
  { href: '/import', label: 'Import' },
];

function isActive(pathname: string, item: NavItem): boolean {
  if (item.href === '/') {
    return pathname === '/' || (item.extraPrefixes ?? []).some((p) => pathname.startsWith(p));
  }
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export function AppNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Hauptnavigation" className="flex h-full items-stretch gap-4">
      {ITEMS.map((item) => {
        const active = isActive(pathname, item);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cx(
              'relative flex items-center text-base transition-colors duration-75',
              'after:absolute after:inset-x-0 after:-bottom-px after:h-0.5',
              active
                ? 'font-medium text-fg after:bg-accent'
                : 'text-muted after:bg-transparent hover:text-fg',
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * Der Hinweis auf die Kommandopalette.
 *
 * Rendert nur den Platz und das Kuerzel; die Palette selbst baut ein anderer
 * Teil der Anwendung (components/command-palette.tsx). Verbunden sind beide
 * ueber ein Fensterereignis (lib/ui-events.ts) - so kann der Hinweis in der
 * Kopfzeile stehen, ohne die Palette zu kennen, und die Palette kann ersetzt
 * werden, ohne die Kopfzeile anzufassen.
 */
export function CommandPaletteHint() {
  const [modifier, setModifier] = useState('⌘');

  // Erst nach dem Mounten, weil die Plattform serverseitig nicht bekannt ist -
  // in das HTML gerendert waere sie eine Hydrations-Abweichung.
  useEffect(() => {
    const platform = `${navigator.userAgent} ${navigator.platform}`;
    if (!/Mac|iPhone|iPad|iPod/i.test(platform)) {
      setModifier('Strg');
    }
  }, []);

  return (
    <button
      type="button"
      onClick={openCommandPalette}
      className={cx(
        'flex h-7 items-center gap-2 rounded-sm border border-border bg-surface pr-1.5 pl-2',
        'text-base text-muted transition-colors duration-75',
        'hover:border-border-strong hover:text-fg',
      )}
    >
      <IconSearch className="text-faint" />
      <span>Suchen</span>
      <Kbd>{modifier}K</Kbd>
    </button>
  );
}
