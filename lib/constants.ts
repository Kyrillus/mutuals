/**
 * Feste Wertelisten des Datenmodells.
 *
 * Diese Datei ist die einzige Quelle für erlaubte Werte von stage, status,
 * role und source. Die CHECK-Constraints in den Migrationen, die zod-Schemas
 * und die UI müssen sich an diesen Listen orientieren.
 */

/**
 * Reihenfolge ist bindend: sie bestimmt die Spaltenreihenfolge im Kanban-Board.
 */
export const STAGES = ['new', 'reached_out', 'in_touch', 'close', 'dormant'] as const;

export const CONTACT_STATUSES = ['imported', 'active', 'archived'] as const;

export const ROLES = ['founder', 'investor', 'operator', 'student', 'community', 'other'] as const;

export const SOURCES = ['manual', 'linkedin', 'csv'] as const;

export type Stage = (typeof STAGES)[number];
export type ContactStatus = (typeof CONTACT_STATUSES)[number];
export type Role = (typeof ROLES)[number];
export type Source = (typeof SOURCES)[number];

/** Nähe zum Kontakt, 1 = lose bekannt, 5 = eng. Nullable in der Datenbank. */
export const CLOSENESS_MIN = 1;
export const CLOSENESS_MAX = 5;

export const STAGE_LABELS: Record<Stage, string> = {
  new: 'Neu',
  reached_out: 'Angeschrieben',
  in_touch: 'Im Austausch',
  close: 'Eng',
  dormant: 'Eingeschlafen',
};

export const STATUS_LABELS: Record<ContactStatus, string> = {
  imported: 'Importiert',
  active: 'Aktiv',
  archived: 'Archiviert',
};

export const ROLE_LABELS: Record<Role, string> = {
  founder: 'Gründer',
  investor: 'Investor',
  operator: 'Operator',
  student: 'Student',
  community: 'Community',
  other: 'Sonstige',
};

export const SOURCE_LABELS: Record<Source, string> = {
  manual: 'Manuell',
  linkedin: 'LinkedIn',
  csv: 'CSV',
};

/**
 * Gemeinsame Basis der Type-Guards. Der Cast auf readonly string[] ist nötig,
 * weil includes() auf einem const-Array nur die Literale als Argument annimmt.
 */
function isMemberOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

export function isStage(value: unknown): value is Stage {
  return isMemberOf(STAGES, value);
}

export function isContactStatus(value: unknown): value is ContactStatus {
  return isMemberOf(CONTACT_STATUSES, value);
}

export function isRole(value: unknown): value is Role {
  return isMemberOf(ROLES, value);
}

export function isSource(value: unknown): value is Source {
  return isMemberOf(SOURCES, value);
}

export function isCloseness(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= CLOSENESS_MIN &&
    value <= CLOSENESS_MAX
  );
}
