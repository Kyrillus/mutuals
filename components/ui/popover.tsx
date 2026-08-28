'use client';

import { useEffect, useRef, type ReactNode } from 'react';

import { cx } from './cx';

/**
 * Angehefteter Bereich fuer Filter-Menues und die Tag-Autovervollstaendigung.
 *
 * Bewusst KEINE Fokusfalle - anders als Sheet und Dialog. Ein Popover ist
 * nicht modal: der Fokus bleibt beim Ausloeser (Filterknopf, Tag-Eingabefeld),
 * damit man weitertippen kann, waehrend die Vorschlaege stehen. Genau deshalb
 * ist das hier auch kein <dialog>.
 *
 * Der Aufrufer besitzt den Ausloeser und den Anker. Erwartete Benutzung:
 *
 *   <div className="relative">
 *     <Button onClick={toggle} aria-expanded={open}>Stadt</Button>
 *     <Popover open={open} onClose={close} align="start">
 *       ...
 *     </Popover>
 *   </div>
 *
 * Geschlossen wird bei Escape und bei einem Zeigerdruck ausserhalb des
 * umgebenden Ankers. Der Ausloeser selbst liegt IM Anker und wird deshalb nicht
 * als "ausserhalb" gewertet - sonst wuerde sein eigenes onClick den gerade
 * geschlossenen Bereich sofort wieder oeffnen.
 */
export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  /** Ausrichtung am Anker. */
  align?: 'start' | 'end';
  /** 'anchor' uebernimmt die Breite des Ankers, sonst Eigenbreite. */
  width?: 'anchor' | 'auto';
  className?: string;
  children: ReactNode;
}

export function Popover({
  open,
  onClose,
  align = 'start',
  width = 'auto',
  className,
  children,
}: PopoverProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointerDown = (event: PointerEvent): void => {
      const panel = panelRef.current;
      const anchor = panel?.parentElement ?? null;
      const target = event.target;
      if (anchor === null || !(target instanceof Node)) {
        return;
      }
      if (anchor.contains(target)) {
        return;
      }
      onClose();
    };

    /**
     * Capture-Phase und stopPropagation: liegt das Popover in einem Sheet,
     * soll Escape zuerst NUR das Popover schliessen und nicht gleich das
     * ganze Slide-over. In der Capture-Phase am Dokument laeuft dieser
     * Handler vor jedem React-Handler im Baum darunter.
     */
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') {
        return;
      }
      event.stopPropagation();
      event.preventDefault();
      onClose();
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div
      ref={panelRef}
      className={cx(
        'absolute top-[calc(100%+4px)] z-30 max-h-72 overflow-y-auto rounded-md border border-border',
        'bg-surface-raised p-1 shadow-lg',
        align === 'start' ? 'left-0' : 'right-0',
        width === 'anchor' ? 'w-full' : 'min-w-48',
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Eine Zeile im Popover. Immer ein Knopf, nie ein div mit onClick - sonst ist
 * das Menue mit der Tastatur nicht erreichbar.
 */
export function PopoverItem({
  onClick,
  selected = false,
  children,
  className,
}: {
  onClick: () => void;
  /** Haken links, z.B. beim aktiven Filterwert. */
  selected?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cx(
        'flex h-7 w-full items-center gap-2 rounded-xs px-2 text-left text-base',
        'text-fg transition-colors duration-75 hover:bg-surface-sunken',
        className,
      )}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {selected ? <span className="text-2xs text-faint">aktiv</span> : null}
    </button>
  );
}
