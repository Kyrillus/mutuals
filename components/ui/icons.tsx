/**
 * Die funktionalen Icons der Oberflaeche.
 *
 * Alle selbst gezeichnet, 16er-Raster, einfarbig in currentColor, 14px gross.
 * Keine Icon-Bibliothek und keine dekorativen Icons: jedes Symbol hier steht
 * fuer eine Bedienung (schliessen, sortieren, ziehen, aufklappen), nie fuer
 * Schmuck. Wer ein weiteres braucht, zeichnet es hier dazu.
 *
 * aria-hidden, weil das Icon nie die einzige Beschriftung ist - der Knopf
 * darum traegt sein Label als Text oder als aria-label.
 */
import type { ReactNode, SVGProps } from 'react';

export type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'>;

function Icon({ children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export function IconClose(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Icon>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="7" cy="7" r="4" />
      <path d="M10 10l3 3" />
    </Icon>
  );
}

export function IconChevronDown(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 6.5L8 10.5l4-4" />
    </Icon>
  );
}

export function IconChevronRight(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6.5 4l4 4-4 4" />
    </Icon>
  );
}

/** Sortierpfeil, aufsteigend. */
export function IconArrowUp(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 12.5V3.5M4.5 7L8 3.5 11.5 7" />
    </Icon>
  );
}

/** Sortierpfeil, absteigend. */
export function IconArrowDown(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 3.5v9M4.5 9L8 12.5 11.5 9" />
    </Icon>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 8.5l3 3 6-7" />
    </Icon>
  );
}

export function IconPlus(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 3.5v9M3.5 8h9" />
    </Icon>
  );
}

export function IconTrash(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.5 8h5l.5-8" />
    </Icon>
  );
}

/** Griff zum Ziehen (Board-Karten). */
export function IconDrag(props: IconProps) {
  return (
    <Icon stroke="none" fill="currentColor" {...props}>
      <circle cx="6" cy="4" r="1.05" />
      <circle cx="10" cy="4" r="1.05" />
      <circle cx="6" cy="8" r="1.05" />
      <circle cx="10" cy="8" r="1.05" />
      <circle cx="6" cy="12" r="1.05" />
      <circle cx="10" cy="12" r="1.05" />
    </Icon>
  );
}
