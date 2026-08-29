'use client';

import type { KeyboardEvent } from 'react';

import { Button, cx } from '@/components/ui';

/**
 * Die Rueckfrage vor dem Loeschen - an Ort und Stelle, nicht als Dialog.
 *
 * Warum kein Dialog: die Detailansicht ist bereits ein modales <dialog>. Ein
 * zweites darin waere ein Modal ueber einem Modal, und Escape muesste sich
 * zwischen beiden entscheiden. Die Frage steht deshalb dort, wo das Objekt
 * steht, um das es geht: an der Zeile, an der Notiz, im Fuss. Man sieht beim
 * Bestaetigen noch, was man loescht.
 *
 * Abbrechen steht links und bekommt den Fokus. Ein Loeschen-Knopf unter dem
 * Zeigefinger, der mit der Leertaste ausgeloest wird, weil man ihn nicht
 * erwartet hat, ist der teuerste Bedienfehler dieser Anwendung.
 */
export interface ConfirmInlineProps {
  question: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  pending?: boolean;
  className?: string;
}

export function ConfirmInline({
  question,
  confirmLabel,
  onConfirm,
  onCancel,
  pending = false,
  className,
}: ConfirmInlineProps) {
  // Escape nimmt die Frage zurueck und darf nicht bis zum Slide-over
  // durchlaufen - sonst schliesst sich beim Abbrechen die ganze Ansicht.
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'Escape') {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    onCancel();
  }

  return (
    <div
      onKeyDown={handleKeyDown}
      className={cx('flex min-w-0 items-center gap-1.5', className)}
      role="group"
      aria-label={question}
    >
      <span className="min-w-0 flex-1 truncate text-sm text-muted">{question}</span>
      <Button size="sm" variant="outline" onClick={onCancel} autoFocus className="shrink-0">
        Abbrechen
      </Button>
      <Button
        size="sm"
        variant="danger"
        onClick={onConfirm}
        loading={pending}
        className="shrink-0"
      >
        {confirmLabel}
      </Button>
    </div>
  );
}
