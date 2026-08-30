'use client';

import type { ComponentPropsWithRef } from 'react';

import { cx } from './cx';

/**
 * Einzeiliges Eingabefeld, 28px hoch wie alle Bedienelemente.
 *
 * Der Fehlerzustand haengt an aria-invalid und nicht an einem eigenen Prop:
 * damit sind die sichtbare Markierung und die Ansage fuer Screenreader
 * dasselbe Signal und koennen nicht auseinanderlaufen.
 */
export const INPUT_CLASS =
  'h-7 w-full rounded-sm border border-border bg-surface px-2 text-base text-fg ' +
  'placeholder:text-faint transition-colors duration-75 ' +
  'hover:border-border-strong ' +
  'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-muted ' +
  'aria-invalid:border-danger';

export function Input({ className, ...props }: ComponentPropsWithRef<'input'>) {
  return <input className={cx(INPUT_CLASS, className)} {...props} />;
}
