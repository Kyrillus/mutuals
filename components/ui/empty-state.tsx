/**
 * Leerer Zustand, ausformuliert.
 *
 * Jede Liste, jede Spalte und jeder Abschnitt bekommt einen: "Noch keine Needs
 * erfasst" sagt, dass die Anwendung funktioniert und was als naechstes zu tun
 * ist. Eine leere Flaeche sagt nur, dass irgendetwas fehlt - und laesst offen,
 * ob es die Daten sind oder die Software.
 */
import type { ReactNode } from 'react';

import { cx } from './cx';

export interface EmptyStateProps {
  /** Ein ganzer Satz, kein Schlagwort. */
  title: string;
  description?: string;
  /** Optional genau eine Aktion, die aus dem leeren Zustand herausfuehrt. */
  action?: ReactNode;
  /** 'plain' fuer kleine Abschnitte, 'framed' fuer ganze Ansichten. */
  variant?: 'plain' | 'framed';
  className?: string;
}

export function EmptyState({
  title,
  description,
  action,
  variant = 'plain',
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cx(
        'flex flex-col items-center justify-center gap-1.5 px-6 text-center',
        variant === 'framed' ? 'rounded-md border border-border py-14' : 'py-8',
        className,
      )}
    >
      <p className="text-base font-medium text-fg">{title}</p>
      {description === undefined ? null : (
        <p className="max-w-80 text-sm text-muted">{description}</p>
      )}
      {action === undefined ? null : <div className="mt-2">{action}</div>}
    </div>
  );
}
