'use client';

import { useId, type ReactNode } from 'react';

import { Button } from './button';
import { cx } from './cx';
import { IconClose } from './icons';
import { DIALOG_ELEMENT_CLASS, useNativeDialog } from './use-native-dialog';

/**
 * Mittiger Dialog. Traegt die Kommandopalette und Rueckfragen.
 *
 * Gleiche Mechanik wie das Sheet (natives <dialog>, siehe
 * use-native-dialog.ts), andere Form: oben mittig statt am rechten Rand, weil
 * die Palette dort erwartet wird und der Blick beim Tippen nicht wandern soll.
 *
 * title ist optional. Ohne Titel MUSS ariaLabel gesetzt sein - das ist der
 * Fall der Palette, deren Kopf das Suchfeld selbst ist.
 */
export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  /** Pflicht, wenn kein title gesetzt ist. */
  ariaLabel?: string;
  footer?: ReactNode;
  /** 'sm' fuer Rueckfragen, 'md' fuer die Palette. */
  width?: 'sm' | 'md';
  /** Ohne Innenabstand rendern - fuer Listen, die bis an den Rand laufen. */
  flush?: boolean;
  children: ReactNode;
}

const WIDTHS: Record<'sm' | 'md', string> = {
  sm: 'max-w-[420px]',
  md: 'max-w-[560px]',
};

export function Dialog({
  open,
  onClose,
  title,
  ariaLabel,
  footer,
  width = 'sm',
  flush = false,
  children,
}: DialogProps) {
  const titleId = useId();
  const { dialogRef, panelRef, handleNativeClose, handleKeyDown, handleBackdropMouseDown } =
    useNativeDialog(open, onClose);

  return (
    <dialog
      ref={dialogRef}
      aria-modal="true"
      aria-label={title === undefined ? ariaLabel : undefined}
      aria-labelledby={title === undefined ? undefined : titleId}
      onClose={handleNativeClose}
      onKeyDown={handleKeyDown}
      className={DIALOG_ELEMENT_CLASS}
    >
      <div
        className="flex h-full items-start justify-center px-4 pt-[12vh] pb-4"
        onMouseDown={handleBackdropMouseDown}
      >
        <div
          ref={panelRef}
          tabIndex={-1}
          className={cx(
            'flex max-h-full w-full flex-col rounded-md border border-border bg-surface shadow-lg outline-none',
            'transition-[translate,opacity] duration-150 ease-out',
            'starting:-translate-y-2 starting:opacity-0',
            WIDTHS[width],
          )}
        >
          {title === undefined ? null : (
            <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border pr-2 pl-4">
              <h2 id={titleId} className="flex-1 truncate text-md font-semibold text-fg">
                {title}
              </h2>
              <Button size="icon" onClick={onClose} aria-label="Schliessen">
                <IconClose />
              </Button>
            </header>
          )}

          <div className={cx('min-h-0 flex-1 overflow-y-auto', flush ? '' : 'px-4 py-3.5')}>
            {children}
          </div>

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
