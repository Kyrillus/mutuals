/**
 * §8.1, flow 2: import a LinkedIn CSV end to end, with its duplicates.
 *
 * **Rewritten in Stage 5, not merely un-`fixme`d.** The version written in Stage 1 recorded the
 * assertion set from reading the fixture, and every number in it was wrong: it claimed 6 data rows
 * and two deliberate collisions, and asserted that 4 contacts land. Measured against the real
 * reader, the real auto-mapper, `mutuals_norm` and the real matcher, the file holds **31 data rows,
 * six duplicate pairs and one unusable email**, so **24 contacts land** when every flagged row is
 * left undecided. ADR-098 has the table and says why the change was allowed.
 *
 * Two of its claims were wrong in kind rather than in degree, and both are asserted the right way
 * round here. The Håkansson pair is an *exact* identifier match — the two rows share a LinkedIn URL
 * — not the fuzzy one the old comment described. And nothing is preselected to merge: Q4 settled
 * that a flagged row is asked about, in as many words, with **not importing** as the default.
 *
 * The API's own integration test covers the bands, the fact log and re-import idempotency. This one
 * covers what only a browser can: that a person can actually get from a file to contacts.
 */
import { fileURLToPath } from 'node:url'
import { expect, test } from '../support/fixtures.ts'

const LINKEDIN_CSV = fileURLToPath(
  new URL('../../fixtures/linkedin_connections_sample.csv', import.meta.url),
)

test('a LinkedIn export imports, and its duplicates are caught before they land', async ({
  page,
}) => {
  await page.goto('/contacts')

  // `.first()` because an empty contacts table renders its own add button in the empty state, so
  // there are two on this page. The header's is the one a person reaches for.
  await page.getByRole('button', { name: 'More ways to add' }).first().click()
  await page.getByRole('menuitem', { name: /Bulk import/ }).click()
  await expect(page.getByRole('heading', { name: /Import contacts/ })).toBeVisible()

  // --- 1. the file, and the mapping it should guess ---------------------------------------------

  await page.getByLabel('Source format').selectOption('linkedin')
  await page.locator('#import-file').setInputFiles(LINKEDIN_CSV)

  // LinkedIn's export carries three preamble lines before the header. The wizard has to find the
  // header row rather than treating "Notes:" as one — so `First Name` is a column, not a value.
  await expect(page.getByText('7 of 7 columns mapped')).toBeVisible()

  // §6.8: the preset maps LinkedIn's column names without being told. `Position` becomes the
  // organization link's job title, which is what §6.8 asks for — not the `job_role` select, whose
  // six options are categories rather than titles.
  await expect(page.getByLabel('Map First Name to')).toHaveValue('first_name')
  await expect(page.getByLabel('Map Email Address to')).toHaveValue('email')
  await expect(page.getByLabel('Map Position to')).toHaveValue('organization.title')
  await expect(page.getByLabel('Map Connected On to')).toHaveValue('organization.from')

  await page.getByRole('button', { name: 'Confirm mapping' }).click()

  // --- 2. the duplicates it should find ----------------------------------------------------------

  await expect(page.getByRole('tab', { name: 'All rows (31)' })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Error rows (1)' })).toBeVisible()
  await expect(page.getByRole('tab', { name: 'Possible duplicates (6)' })).toBeVisible()
  await expect(page.getByText('6 rows look like duplicates')).toBeVisible()

  const grid = page.getByRole('table', { name: 'Rows to review' })

  // Two collisions of different kinds, and the wording distinguishes them. Both are row-against-row
  // inside this file (ADR-097): on a first import there is nothing in the workspace to match.
  const anna = grid.getByRole('row', { name: 'Anna Berger' }).nth(1)
  await expect(anna).toContainText('Almost certainly a duplicate')
  await expect(anna).toContainText('Same email')

  const bjoern = grid.getByRole('row', { name: 'Bjoern Hakansson' })
  await expect(bjoern).toContainText('Almost certainly a duplicate')
  // Not "fuzzy": they share a LinkedIn profile exactly, which §4.6 makes near-certain.
  await expect(bjoern).toContainText('Same LinkedIn profile')

  // Q4: nothing is pre-decided. Every flagged row is undecided, and the button counts them out.
  await expect(anna.getByRole('button', { name: "Don't import" })).toHaveAttribute(
    'aria-pressed',
    'false',
  )

  // --- 3. what actually lands ---------------------------------------------------------------------

  // §6.8: "the button says so". 31 rows, minus six undecided duplicates and one unusable email.
  const importButton = page.getByRole('button', { name: /^Import 24 rows/ })
  await expect(importButton).toContainText('7 will be skipped')
  await importButton.click()

  await expect(page.getByRole('heading', { name: 'Import finished' })).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.getByText('Created')).toBeVisible()
  await expect(page.locator('dl')).toContainText('24')

  // --- 4. and they are real contacts, attributable to the file ------------------------------------

  await page.getByRole('link', { name: 'See what was imported' }).click()
  await expect(page.getByRole('link', { name: 'Anna Berger' }).first()).toBeVisible()

  // The organization was created once and the link carries the job title from `Position` (§4.3).
  await page.getByRole('link', { name: 'Aisha Rahman' }).first().click()
  await expect(page.getByText('Nimbus Health').first()).toBeVisible()
})

test('the error report explains every row that did not land', async ({ page }) => {
  await page.goto('/import?objectType=contact')
  await page.getByLabel('Source format').selectOption('linkedin')
  await page.locator('#import-file').setInputFiles(LINKEDIN_CSV)
  await page.getByRole('button', { name: 'Confirm mapping' }).click()

  // The one row whose email cannot be read is marked, and says so on the cell rather than only in a
  // count — §6.8 step 4's `Find errors` is a filter over something already visible.
  await page.getByRole('tab', { name: /Error rows/ }).click()
  const grid = page.getByRole('table', { name: 'Rows to review' })
  await expect(grid.getByRole('row', { name: 'Ana Silva' })).toContainText('not an email')

  // Fixing it in place clears the error and the row rejoins the import.
  await grid.getByLabel('Row 27 email').fill('ana.silva@orchard-talent.example')
  await grid.getByLabel('Row 27 first_name').click()
  await expect(page.getByRole('tab', { name: 'Error rows (0)' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Import 25 rows/ })).toBeVisible()
})
