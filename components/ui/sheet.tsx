'use client';

import { useId, type ReactNode } from 'react';

import { Button } from './button';
import { cx } from './cx';
import { IconClose } from './icons';
import { DIALOG_ELEMENT_CLASS, useNativeDialog } from './use-native-dialog';

/**
 * Slide-over von rechts. Traegt die Detailansicht eines Kontakts.
 *
 * Fokusfalle, Escape, Fokusrueckgabe und das gesperrte Scrollen dahinter kommen
 * vom nativen <dialog> - siehe use-native-dialog.ts. Hier liegt nur die Form:
 * ein Panel am rechten Rand, mit Kopf, scrollendem Inhalt und optionalem Fuss.
 *
 * Der Schatten ist die einzige Stelle neben dem Dialog, an der es einen gibt.
 * Er ist erlaubt, weil das Panel ueber der Anwendung liegt und nicht Teil von
 * ihr ist; die eigentliche Trennung leistet trotzdem der 1px-Rahmen links.
 */
export interface SheetProps {
  open: boolean;
  /** Wird bei Escape, Klick auf den Grund und Klick auf das Kreuz gerufen. */
  onClose: () => void;
  title: string;
  /** Zeile unter dem Titel, z.B. Firma und Ort. */
  subtitle?: ReactNode;
  /** Aktionen rechts im Kopf, links vom Schliessen-Kreuz. */
  actions?: ReactNode;
  footer?: ReactNode;
  width?: 'md' | 'lg';
  children: ReactNode;
}

const WIDTHS: Record<'md' | 'lg', string> = {
  md: 'max-w-[440px]',
  lg: 'max-w-[600px]',
};

export function Sheet({
  open,
  onClose,
  title,
  subtitle,
  actions,
  footer,
  width = 'md',
  children,
}: SheetProps) {
  const titleId = useId();
  const { dialogRef, panelRef, handleNativeClose, handleKeyDown, handleBackdropMouseDown } =
    useNativeDialog(open, onClose);

  return (
    <dialog
      ref={dialogRef}
      aria-modal="true"
      aria-labelledby={titleId}
      onClose={handleNativeClose}
      onKeyDown={handleKeyDown}
      className={DIALOG_ELEMENT_CLASS}
    >
      <div className="flex h-full justify-end" onMouseDown={handleBackdropMouseDown}>
        <div
          ref={panelRef}
          tabIndex={-1}
          className={cx(
            'flex h-full w-full flex-col border-l border-border bg-surface shadow-lg outline-none',
            'transition-[translate,opacity] duration-150 ease-out',
            'starting:translate-x-4 starting:opacity-0',
            WIDTHS[width],
          )}
        >
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
            <div className="flex min-w-0 flex-1 items-baseline gap-2">
              <h2 id={titleId} className="truncate text-lg font-semibold tracking-tight text-fg">
                {title}
              </h2>
              {subtitle === undefined ? null : (
                <span className="truncate text-sm text-muted">{subtitle}</span>
              )}
            </div>
            {actions}
            <Button size="icon" onClick={onClose} aria-label="Schliessen">
              <IconClose />
            </Button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>

          {footer === undefined ? null : (
            <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-2.5">
              {footer}
            </footer>
          )}
        </div>
      </div>
    </dialog>
  );
}
