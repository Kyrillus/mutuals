'use client';

import type { ComponentPropsWithRef } from 'react';

import { cx } from './cx';
import { IconChevronDown } from './icons';

/**
 * Auswahlfeld auf Basis des nativen select.
 *
 * Bewusst nativ: die Tastaturbedienung (Tippen springt zum Eintrag, Pos1/Ende,
 * Escape verwirft), die Bildschirmleser-Ansage und das Verhalten auf kleinen
 * Geraeten sind hier geschenkt und in einer Nachbau-Liste erfahrungsgemaess
 * halb kaputt. Angepasst wird nur die geschlossene Darstellung; die
 * aufgeklappte Liste gehoert dem Betriebssystem.
 */
export function Select({ className, children, ...props }: ComponentPropsWithRef<'select'>) {
  return (
    <span className="relative inline-flex w-full items-center">
      <select
        className={cx(
          'h-7 w-full appearance-none rounded-sm border border-border bg-surface pl-2 pr-6',
          'text-base text-fg transition-colors duration-75',
          'hover:border-border-strong',
          'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-muted',
          'aria-invalid:border-danger',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <IconChevronDown className="pointer-events-none absolute right-1.5 text-faint" />
    </span>
  );
}
