/**
 * §6.8 step 1's "Source format" presets, and the header-row detection every CSV needs.
 *
 * A preset is knowledge about one export's column names, nothing more. It proposes targets that are
 * then resolved against the workspace's actual fields, so a preset naming an attribute the user has
 * deleted contributes nothing rather than failing.
 */
import type { ObjectType } from '../attributes/kinds.ts'
import type { DateFormat } from './dates.ts'
import { normalizeHeader } from './header.ts'

export const IMPORT_SOURCES = ['generic', 'linkedin', 'google_contacts', 'apple_vcard'] as const
export type ImportSource = (typeof IMPORT_SOURCES)[number]

export interface ImportPreset {
  readonly id: ImportSource
  readonly label: string
  readonly objectTypes: readonly ObjectType[]
  /** ADR-096: vCard is deferred, and shows in the dropdown disabled rather than vanishing. */
  readonly available: boolean
  readonly extensions: readonly string[]
  /** Normalised header to target id. Read through {@link presetTarget}, never directly. */
  readonly columns: Readonly<Record<string, string>>
  /** Where the export's own spelling settles a date column with no inference needed. */
  readonly dateFormats?: Readonly<Record<string, DateFormat>>
  readonly unavailableReason?: string
}

const LINKEDIN: ImportPreset = {
  id: 'linkedin',
  label: 'LinkedIn Connections export',
  objectTypes: ['contact'],
  available: true,
  extensions: ['.csv'],
  columns: {
    'first name': 'first_name',
    'last name': 'last_name',
    // Not `website`: in this file the bare "URL" column is always the profile.
    url: 'linkedin_url',
    'email address': 'email',
    company: 'organization',
    // §6.8 names both of these explicitly. "Connected On" as the link's `from` reads as provenance
    // rather than as a start date — on that day they were at that company in that role, which is
    // exactly what the export witnesses and exactly what a fact's `valid_from` means (§4.5).
    position: 'organization.title',
    'connected on': 'organization.from',
  },
  dateFormats: { 'connected on': 'd_mon_y' },
}

const GOOGLE_CONTACTS: ImportPreset = {
  id: 'google_contacts',
  label: 'Google Contacts CSV',
  objectTypes: ['contact'],
  available: true,
  extensions: ['.csv'],
  columns: {
    'first name': 'first_name',
    'last name': 'last_name',
    'organization name': 'organization',
    'organization title': 'organization.title',
    birthday: 'birthday',
    notes: 'notes',
    // Only the first of each repeated group. ADR-044's one-target-one-column rule is what stops
    // "E-mail 2 - Value" silently overwriting the address that came from "E-mail 1 - Value"; the
    // second column arrives unmapped and the user can point it at a field of their own.
    'e mail 1 value': 'email',
    'phone 1 value': 'phone',
    'address 1 city': 'city',
    'address 1 country': 'country',
    'website 1 value': 'website',
  },
  dateFormats: { birthday: 'iso' },
}

const GENERIC: ImportPreset = {
  id: 'generic',
  label: 'Generic CSV/Excel',
  objectTypes: ['contact', 'organization'],
  available: true,
  extensions: ['.csv', '.xlsx'],
  columns: {},
}

const APPLE_VCARD: ImportPreset = {
  id: 'apple_vcard',
  label: 'Apple Contacts vCard (.vcf)',
  objectTypes: ['contact'],
  available: false,
  extensions: ['.vcf'],
  columns: {},
  unavailableReason: 'vCard import is not built yet — export as CSV for now.',
}

export const IMPORT_PRESETS: readonly ImportPreset[] = Object.freeze([
  GENERIC,
  LINKEDIN,
  GOOGLE_CONTACTS,
  APPLE_VCARD,
])

export function importPreset(id: ImportSource): ImportPreset {
  const found = IMPORT_PRESETS.find((preset) => preset.id === id)
  if (found === undefined) throw new Error(`Unknown import source: ${id}`)
  return found
}

/** The presets offered for one object type, disabled ones included. */
export function presetsFor(objectType: ObjectType): readonly ImportPreset[] {
  return IMPORT_PRESETS.filter((preset) => preset.objectTypes.includes(objectType))
}

export function presetTarget(preset: ImportPreset, header: string): string | undefined {
  return preset.columns[normalizeHeader(header)]
}

export function presetDateFormat(preset: ImportPreset, header: string): DateFormat | undefined {
  return preset.dateFormats?.[normalizeHeader(header)]
}

/**
 * Which row of a sheet is the header.
 *
 * LinkedIn puts three lines of prose above its header, and the number is not a documented promise —
 * so it is not counted. Instead: the header is the first row that is as wide as the file's rows
 * generally are. The preamble lines are one cell wide, the header and every data row are seven, and
 * that difference is structural rather than a fact about LinkedIn's current exporter.
 *
 * Ties are broken towards the earlier row, and a file with no clear modal width falls back to row
 * 0 — a plain CSV, which is the overwhelmingly common case, takes that path immediately.
 */
export function detectHeaderRow(rows: readonly (readonly string[])[], limit = 20): number {
  if (rows.length === 0) return 0

  const widths = new Map<number, number>()
  for (const row of rows.slice(0, 200)) {
    // Raw cell count, *not* the count ignoring trailing empties. A well-formed CSV row has one cell
    // per delimiter whether the trailing cells hold anything or not, so the header and a sparse
    // data row are the same width — while a prose preamble line, which has no delimiters at all, is
    // one cell wide. Measuring content instead made Google Contacts pick row 2 as its header,
    // because most of its rows end in an empty cell and the header does not.
    if (row.length > 1) widths.set(row.length, (widths.get(row.length) ?? 0) + 1)
  }
  if (widths.size === 0) return 0

  let modal = 0
  let best = 0
  for (const [width, count] of widths) {
    // A wider row wins an equal count: a 7-column file also contains many 1-column stretches.
    if (count > best || (count === best && width > modal)) {
      modal = width
      best = count
    }
  }

  const found = rows.slice(0, limit).findIndex((row) => row.length === modal)
  return found === -1 ? 0 : found
}
