/**
 * Tastenkuerzel als kleine Taste.
 *
 * Eigene Komponente, weil das Kuerzel an mehreren Stellen auftaucht (Kopfzeile,
 * Kommandopalette, Leerzustaende) und ueberall gleich aussehen muss.
 */
import type { ReactNode } from 'react';

import { cx } from './cx';

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cx(
        'inline-flex h-4 min-w-4 items-center justify-center rounded-xs border border-border',
        'bg-surface-sunken px-1 font-sans text-2xs leading-none font-medium text-faint',
        className,
      )}
    >
      {children}
    </kbd>
  );
}
