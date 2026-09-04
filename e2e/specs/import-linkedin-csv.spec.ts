/**
 * §8.1, flow 2: import a LinkedIn CSV fixture end-to-end, with a duplicate.
 *
 * **`fixme`, not `skip`.** The import wizard is Stage 5 (§6.8) and the merge screen is §6.9; neither
 * exists yet, so there is nothing to click. What is written below is the assertion set the flow has
 * to satisfy when it does exist, recorded now while the fixture's contents are the reason for each
 * number — `fixtures/linkedin_connections_sample.csv` was built with these collisions on purpose:
 *
 *   - "Anna Berger" appears twice, same address in two cases (`ANNA.BERGER@…` / `anna.berger@…`).
 *     `mutuals_norm()` folds them, so this is an exact-identifier duplicate and must be near-certain.
 *   - "Björn Håkansson" and "Bjoern Hakansson" share one LinkedIn URL and differ by diacritic fold
 *     in both names. Different email addresses, so this is a fuzzy match, not an exact one.
 *
 * Stage 5 turns these into: `test('…', …)`. If the numbers below need changing then, the change is
 * the interesting part of that PR — say why in the body.
 */
import { fileURLToPath } from 'node:url'
import { expect, test } from '../support/fixtures.ts'

const LINKEDIN_CSV = fileURLToPath(
  new URL('../../fixtures/linkedin_connections_sample.csv', import.meta.url),
)

test.fixme('a LinkedIn export imports, and its duplicates are caught before they land', async ({
  page,
}) => {
  await page.goto('/contacts')

  await page.getByRole('button', { name: 'More ways to add' }).click()
  await page.getByRole('menuitem', { name: /Bulk import/ }).click()

  // --- 1. the file, and the mapping it should guess ---------------------------------------------

  await page.getByLabel(/Choose a file|Drop a CSV/).setInputFiles(LINKEDIN_CSV)

  // LinkedIn's export carries three preamble lines before the header. The wizard has to find the
  // header row rather than treating "Notes:" as one.
  await expect(page.getByText('First Name')).toBeVisible()

  // §6.8: the preset maps LinkedIn's column names without being told.
  await expect(page.getByRole('row', { name: /First Name/ })).toContainText('First name')
  await expect(page.getByRole('row', { name: /Email Address/ })).toContainText('Email')
  await expect(page.getByRole('row', { name: /Position/ })).toContainText('Job role')

  await page.getByRole('button', { name: /Continue|Next/ }).click()

  // --- 2. the duplicates it should find ---------------------------------------------------------

  // Two collisions in the fixture, and they are not the same kind. The exact one is preselected to
  // merge; the fuzzy one is not (Q4 in docs/DECISIONS.md §14 — settle it before writing this).
  const review = page.getByRole('table', { name: /review/i })
  await expect(review.getByRole('row', { name: /Anna Berger/ })).toContainText(
    /near-certain|exact/i,
  )
  await expect(review.getByRole('row', { name: /H[åa]kansson/ })).toContainText(/possible|likely/i)

  await expect(page.getByText(/2 possible duplicates/i)).toBeVisible()

  // --- 3. what actually lands -------------------------------------------------------------------

  await page.getByRole('button', { name: /Import/ }).click()

  // The file holds 6 data rows; two pairs collapse to one contact each, so 4 contacts land.
  await expect(page.getByText('Rows: 4')).toBeVisible()

  // The merged Anna Berger keeps both addresses rather than losing one: nothing is silently
  // overwritten, and a superseded value is still a fact (§4.5).
  await page.getByRole('link', { name: 'Anna Berger' }).click()
  await expect(page.getByText('anna.berger@northstar-ventures.com')).toBeVisible()

  // And the import is attributable: every row carries the batch it came from (§4.4).
  await expect(page.getByText(/Imported from .*linkedin_connections_sample\.csv/i)).toBeVisible()
})
