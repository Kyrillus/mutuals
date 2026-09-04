/**
 * Generates `contacts_multi_sheet.xlsx`, the fixture for §6.8 step 2 (ADR-096).
 *
 * Committed as a script rather than only as a binary: a checked-in workbook nobody can regenerate
 * is a fixture that cannot be corrected, and the whole point of this file is to exercise a step —
 * "which sheet?" — that only fires for a workbook with more than one sheet.
 *
 *   node fixtures/generate-xlsx.mjs
 *
 * `write-excel-file` is a devDependency of `apps/api` and is used nowhere else. The runtime reader
 * is `read-excel-file`, which cannot write.
 *
 * The three sheets are deliberately unequal. `Team` is the one a person wants; `Notes` comes first
 * so the wizard cannot get away with defaulting to sheet 1; and `Archive 2019` shares two contacts
 * with `Team` so that picking the wrong sheet is visible rather than merely different.
 */
import writeXlsxFile from 'write-excel-file/node'

const NOTES = [
  [{ value: 'Exported from the old spreadsheet' }],
  [{ value: 'Do not edit — see Team' }],
  [],
  [{ value: 'Contact:' }, { value: 'ops@example.invalid' }],
]

const TEAM = [
  [
    { value: 'First Name' },
    { value: 'Last Name' },
    { value: 'Email Address' },
    { value: 'Company' },
    { value: 'Position' },
    { value: 'Started' },
  ],
  ...[
    ['Aisha', 'Rahman', 'aisha.rahman@nimbus-health.example', 'Nimbus Health', 'Head of Product', '03/04/2024'],
    ['Tomás', 'Ferreira', 'tomas@pelago-ocean.example', 'Pelago Ocean', 'Co-Founder', '12/12/2023'],
    ['Zoë', 'Bakker', 'zoe.bakker@kestrelpay.example', 'Kestrel Pay', 'Chief of Staff', '25/08/2023'],
    // Day 17 cannot be a month, so this one cell settles the whole column as day-first (ADR-044).
    ['Amara', 'Okonkwo', 'amara@runbook-systems.example', 'Runbook Systems', 'Head of Sales', '17/04/2024'],
    // No email, and only a last name — both legal, and both worth a row in the Review grid.
    ['', 'Nakamura', '', 'Sirocco Mobility', 'Head of Partnerships', '14/07/2022'],
  ].map((row) => row.map((value) => ({ value, type: String }))),
]

const ARCHIVE = [
  [{ value: 'First Name' }, { value: 'Last Name' }, { value: 'Email Address' }, { value: 'Company' }],
  ...[
    ['Aisha', 'Rahman', 'aisha@old-employer.example', 'Old Employer GmbH'],
    ['Zoë', 'Bakker', 'zoe.bakker@kestrelpay.example', 'Kestrel Pay'],
    ['Henrik', 'Sørensen', 'henrik@kelvin-capital.example', 'Kelvin Capital'],
  ].map((row) => row.map((value) => ({ value, type: String }))),
]

const OUTPUT = new URL('./contacts_multi_sheet.xlsx', import.meta.url).pathname

/**
 * Two things about v4 that look like success when they are not, both found by checking the output
 * rather than the return value: it returns a *writer* and ignores a `filePath` option, and the
 * per-sheet name property is `sheet` rather than `name` — pass `name` and the sheets come out as
 * "Sheet1", "Sheet2", "Sheet3", which is exactly the fixture this test needs not to be.
 * `sheet` is also what `read-excel-file` calls it, so the two agree.
 */
const writer = await writeXlsxFile([
  { sheet: 'Notes', data: NOTES },
  { sheet: 'Team', data: TEAM },
  { sheet: 'Archive 2019', data: ARCHIVE },
])
await writer.toFile(OUTPUT)

console.log(`wrote ${OUTPUT} — 3 sheets: Notes, Team, Archive 2019`)
