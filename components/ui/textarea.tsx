'use client';

import type { ComponentPropsWithRef } from 'react';

import { cx } from './cx';

/**
 * Mehrzeiliges Feld fuer Notizen, Needs und Offers.
 *
 * resize-y und nicht resize: waagerechtes Ziehen wuerde die Spaltenbreite der
 * umgebenden Ansicht sprengen.
 */
export function Textarea({ className, rows, ...props }: ComponentPropsWithRef<'textarea'>) {
  return (
    <textarea
      rows={rows ?? 3}
      className={cx(
        'w-full resize-y rounded-sm border border-border bg-surface px-2 py-1.5 text-base text-fg',
        'placeholder:text-faint transition-colors duration-75',
        'hover:border-border-strong',
        'disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-muted',
        'aria-invalid:border-danger',
        className,
      )}
      {...props}
    />
  );
}
