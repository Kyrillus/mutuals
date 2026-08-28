/**
 * Beschriftetes Formularfeld: Label, Eingabe, Hinweis, Fehler.
 *
 * Existiert, damit die drei Ansichten ihre Formulare nicht dreimal
 * unterschiedlich zusammensetzen. Die Verdrahtung von id, aria-describedby und
 * der Fehlermeldung passiert hier einmal richtig.
 *
 * Benutzung:
 *   <Field label="Name" htmlFor="name" error={error}>
 *     <Input id="name" name="name" aria-invalid={error !== undefined} />
 *   </Field>
 */
import type { ReactNode } from 'react';

import { cx } from './cx';
import { InlineError } from './inline-error';

export interface FieldProps {
  label: string;
  /** id des Bedienelements darin. */
  htmlFor?: string;
  hint?: string;
  error?: string;
  /** Zeigt "Pflicht" neben dem Label. Kein Sternchen - das liest niemand vor. */
  required?: boolean;
  children: ReactNode;
  className?: string;
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  required = false,
  children,
  className,
}: FieldProps) {
  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <label htmlFor={htmlFor} className="flex items-baseline gap-1.5 text-sm font-medium text-fg">
        {label}
        {required ? <span className="text-2xs font-normal text-faint">Pflicht</span> : null}
      </label>
      {children}
      {hint === undefined ? null : <p className="text-sm text-muted">{hint}</p>}
      <InlineError>{error}</InlineError>
    </div>
  );
}
