/**
 * Sehr kleiner Ladehinweis.
 *
 * Bewusst dezent und nur 12px: der Spinner ist nie das Ereignis, er sagt
 * lediglich, dass ein Knopf noch arbeitet. Fuer ganze Bereiche gibt es keinen
 * Spinner - dort wird der Platz reserviert und der Inhalt ruhig deaktiviert
 * (siehe Button loading und die Skelette in den Ansichten).
 */
import { cx } from './cx';

export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <span role="status" aria-live="off" className={cx('inline-flex', className)}>
      <svg
        width="12"
        height="12"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
        focusable="false"
        className="animate-spin"
      >
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.22" />
        <path
          d="M14 8a6 6 0 0 0-6-6"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
      <span className="sr-only">{label ?? 'Wird geladen'}</span>
    </span>
  );
}
