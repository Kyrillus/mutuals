/**
 * §6.3: organizations over the same table, and the detail page behind it.
 *
 * The first assertion is really about §5.2's claim that there is *one* `DataTable`. If a second
 * object type had needed its own table, its own cell registry or its own filter bar, this spec
 * would have been written against a second set of selectors. It is written against the first set.
 */
import { expect, test } from '../support/fixtures.ts'

test('organizations use the same table, with their own columns', async ({ page }) => {
  await page.goto('/organizations')

  await expect(page.getByText('No organizations yet')).toBeVisible()

  await page.getByRole('cell').getByRole('button', { name: 'Add new' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'Add organization' })).toBeVisible()
  await dialog.getByLabel('Name').fill('Analytical Engines Ltd')
  await dialog.getByRole('button', { name: 'Save organization' }).click()
  await expect(dialog).toBeHidden()

  // The same controls as the contacts table, because it is the same component.
  await expect(page.getByRole('button', { name: 'Add filter' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Columns \d+\/\d+$/ })).toBeVisible()

  // §6.3's own default columns, including the derived People count.
  await expect(page.getByRole('columnheader').filter({ hasText: 'People' })).toBeVisible()
  await expect(page.getByRole('row', { name: /Analytical Engines Ltd/ })).toBeVisible()
})

test('an organization detail page opens, and its people count links to them', async ({ page }) => {
  await page.goto('/organizations')
  await page.getByRole('cell').getByRole('button', { name: 'Add new' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Name').fill('Analytical Engines Ltd')
  await dialog.getByRole('button', { name: 'Save organization' }).click()
  await expect(dialog).toBeHidden()

  await page.getByRole('link', { name: /Analytical Engines Ltd/ }).click()

  await expect(page).toHaveURL(/\/organizations\/[0-9a-f-]{36}$/)
  await expect(
    page.getByRole('heading', { name: 'Analytical Engines Ltd', level: 1 }),
  ).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(
    'Analytical Engines Ltd',
  )

  // Nobody works here yet, and the header says so rather than showing a bare 0.
  const people = page.getByRole('link', { name: '0 people' })
  await expect(people).toBeVisible()

  // §6.3: clicking it lands on the contacts table filtered to this organization.
  await people.click()
  await expect(page).toHaveURL(/\/contacts\?.*filter=/)
  await expect(page.getByText('Nothing matches')).toBeVisible()
})
