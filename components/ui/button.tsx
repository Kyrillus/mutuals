'use client';

import type { ComponentPropsWithRef, ReactNode } from 'react';

import { cx } from './cx';
import { Spinner } from './spinner';

/**
 * Der Knopf der Anwendung.
 *
 * Die Varianten sind bewusst wenige und klar verteilt:
 *   ghost    Standard. Kein Rahmen, keine Flaeche im Ruhezustand. Das ist die
 *            Form, in der die allermeisten Aktionen auftreten - eine Ansicht
 *            voller gerahmter Knoepfe ist ein Formular, kein Werkzeug.
 *   outline  Wenn ein Bedienelement als solches erkennbar sein muss, ohne die
 *            primaere Aktion zu sein: Filter, Sortierung, Dateiauswahl.
 *            Trennung ueber 1px-Rahmen, nicht ueber Flaeche.
 *   primary  Hoechstens EINE pro Ansicht. Nur hier erscheint die Akzentfarbe.
 *   danger   Ausschliesslich fuer das Loeschen von Daten.
 *
 * loading blendet die Beschriftung nicht aus, sondern macht sie unsichtbar und
 * legt den Spinner darueber. Der Knopf behaelt damit exakt seine Breite - ein
 * Ladezustand, der das Layout springen laesst, ist schlimmer als keiner.
 */
export type ButtonVariant = 'ghost' | 'outline' | 'primary' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'icon';

export interface ButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'children'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Zeigt den Spinner und sperrt den Knopf, ohne die Breite zu aendern. */
  loading?: boolean;
  children?: ReactNode;
}

const BASE =
  'relative inline-flex select-none items-center justify-center gap-1.5 rounded-sm border ' +
  'text-base font-medium whitespace-nowrap transition-colors duration-75 ' +
  'disabled:pointer-events-none disabled:opacity-45';

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-6 px-2 text-sm',
  md: 'h-7 px-2.5',
  icon: 'h-7 w-7 px-0',
};

const VARIANTS: Record<ButtonVariant, string> = {
  ghost: 'border-transparent bg-transparent text-fg hover:bg-surface-sunken',
  outline: 'border-border bg-surface text-fg hover:border-border-strong hover:bg-surface-sunken',
  primary:
    'border-accent bg-accent text-accent-contrast hover:border-accent-strong hover:bg-accent-strong',
  danger: 'border-transparent bg-transparent text-danger hover:bg-danger-soft',
};

export function Button({
  variant = 'ghost',
  size = 'md',
  loading = false,
  disabled,
  className,
  children,
  type,
  ...props
}: ButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      className={cx(BASE, SIZES[size], VARIANTS[variant], className)}
      {...props}
    >
      <span className={cx('inline-flex items-center gap-1.5', loading && 'invisible')}>
        {children}
      </span>
      {loading ? (
        <span className="absolute inset-0 inline-flex items-center justify-center">
          <Spinner />
        </span>
      ) : null}
    </button>
  );
}
