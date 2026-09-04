/**
 * §8.1, flow 4: a saved-view round trip.
 *
 * A view is "a named set of visible columns + order + filters + sort" (§5.2), and §5.2 also requires
 * that the whole of it lives in the URL so a view can be shared or bookmarked. That makes the URL
 * the round trip worth testing: build a view by clicking, throw the page away, come back with
 * nothing but the address, and the table has to reassemble itself.
 *
 * The seeded views of §6.2 are not asserted here — the reset leaves the database with only what the
 * migrations wrote, and `pnpm seed` is what puts views in. This tests the mechanism they ride on.
 */
import { expect, test } from '../support/fixtures.ts'

test('columns, sort and search survive a round trip through the URL', async ({ page }) => {
  await page.goto('/contacts')

  const phoneHeader = page.getByRole('columnheader', { name: 'Phone', exact: true })
  const nameHeader = page
    .getByRole('columnheader')
    .filter({ has: page.getByRole('button', { name: 'Name', exact: true }) })
  const searchBox = page.getByRole('searchbox', { name: 'Search…' })

  await expect(phoneHeader).toBeVisible()

  // --- build a view by clicking -----------------------------------------------------------------

  await page.getByRole('button', { name: /^Columns \d+\/\d+$/ }).click()
  await page.getByRole('checkbox', { name: 'Hide Phone' }).click()
  await page.keyboard.press('Escape')

  await expect(phoneHeader).toBeHidden()
  await expect(page).toHaveURL(/columns=/)

  await nameHeader.getByRole('button').click()
  await expect(page).toHaveURL(/sort=/)

  await searchBox.fill('Lovelace')
  await expect(page).toHaveURL(/q=Lovelace/)

  const view = page.url()
  const sorted = await nameHeader.getAttribute('aria-sort')
  expect(sorted).toMatch(/ascending|descending/)

  // --- throw the page away, come back with nothing but the address ------------------------------

  await page.goto('/')
  await expect(
    page.getByRole('heading', { name: /Good (morning|afternoon|evening)/ }),
  ).toBeVisible()

  await page.goto(view)

  await expect(searchBox).toHaveValue('Lovelace')
  await expect(phoneHeader).toBeHidden()
  await expect(nameHeader).toHaveAttribute('aria-sort', sorted ?? 'ascending')
})
