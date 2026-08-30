import type { ReactNode } from 'react';

import { cx } from '@/components/ui';

/**
 * Ein Block der Detailansicht: Ueberschrift, Anzahl, Inhalt.
 *
 * Die Anzahl steht neben der Ueberschrift und nicht als Chip daneben - sie ist
 * eine Angabe zum Block, keine Auszeichnung. Getrennt wird ueber eine
 * 1px-Linie nach oben; die Bloecke stapeln sich damit ohne Karten, Schatten
 * oder Abstaende, die man als Trennung deuten muesste.
 */
export interface DetailSectionProps {
  title: string;
  /** Fehlt sie, steht keine Zahl da - nicht die Null. */
  count?: number;
  children: ReactNode;
  className?: string;
}

export function DetailSection({ title, count, children, className }: DetailSectionProps) {
  return (
    <section className={cx('border-t border-border px-4 py-3', className)}>
      <h3 className="flex items-baseline gap-1.5 pb-1.5 text-sm font-medium text-fg">
        {title}
        {count === undefined ? null : (
          <span className="text-sm font-normal text-faint tabular-nums">{count}</span>
        )}
      </h3>
      {children}
    </section>
  );
}
