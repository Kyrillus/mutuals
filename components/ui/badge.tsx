'use client';

import type { ReactNode } from 'react';

import { cx } from './cx';
import { IconClose } from './icons';

/**
 * Chip fuer Tags, Stages, Status und Zaehler.
 *
 * Ohne Farbe: Stages und Tags bekommen ausdruecklich KEINE eigene Farbe (das
 * ist die Regel, an der die meisten CRM-Oberflaechen bunt werden). Die
 * Unterscheidung leistet der Text; wenn ein Chip staerker hervortreten soll,
 * gibt es dafuer die Variante 'solid' mit einer eingesenkten Flaeche.
 *
 * onRemove macht aus dem Chip einen entfernbaren Tag. Das kleine Kreuz ist ein
 * eigener Knopf mit eigenem Label - ein ganzer Chip, der beim Klick
 * verschwindet, ist mit der Tastatur nicht bedienbar und trifft mit der Maus
 * zu leicht daneben.
 */
export type BadgeVariant = 'solid' | 'outline';

export interface BadgeProps {
  children: ReactNode;
  variant?: BadgeVariant;
  /** Wenn gesetzt, erscheint ein Kreuz zum Entfernen. */
  onRemove?: () => void;
  /** Beschriftung des Entfernen-Knopfs, z.B. 'Tag "berlin" entfernen'. */
  removeLabel?: string;
  title?: string;
  className?: string;
}

const VARIANTS: Record<BadgeVariant, string> = {
  solid: 'border-transparent bg-surface-sunken text-muted',
  outline: 'border-border bg-transparent text-muted',
};

export function Badge({
  children,
  variant = 'solid',
  onRemove,
  removeLabel,
  title,
  className,
}: BadgeProps) {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex h-5 max-w-full items-center gap-1 rounded-xs border px-1.5',
        'text-xs leading-none font-medium',
        VARIANTS[variant],
        className,
      )}
    >
      <span className="truncate">{children}</span>
      {onRemove === undefined ? null : (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel ?? 'Entfernen'}
          className="-mr-0.5 inline-flex size-3.5 shrink-0 items-center justify-center rounded-xs text-faint transition-colors duration-75 hover:bg-surface hover:text-fg"
        >
          <IconClose width="10" height="10" />
        </button>
      )}
    </span>
  );
}
