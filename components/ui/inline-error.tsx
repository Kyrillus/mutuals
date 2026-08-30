/**
 * Fehlermeldung direkt an der Stelle, an der sie entstanden ist.
 *
 * role="alert", damit ein Bildschirmleser die Meldung vorliest, sobald sie
 * erscheint - eine Server Action, die fehlschlaegt, aendert sonst nur still
 * ein paar Pixel. children ist null-tolerant: die Ansichten koennen
 * {error && <InlineError>} sparen und stattdessen immer rendern.
 */
import type { ReactNode } from 'react';

import { cx } from './cx';

export function InlineError({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  if (children === null || children === undefined || children === false || children === '') {
    return null;
  }
  return (
    <p role="alert" className={cx('text-sm text-danger', className)}>
      {children}
    </p>
  );
}
