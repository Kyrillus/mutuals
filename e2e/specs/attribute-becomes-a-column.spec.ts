/**
 * §8.1, flow 1: create attribute → it appears as a column → filter by it.
 *
 * This is the flow that proves the product's one rule from the outside. Nothing in the web app was
 * told that a field called "Ticket size" exists; it becomes a column, a filter and a sort because a
 * row was written to `attribute_definition` and for no other reason.
 */
import { expect, test } from '../support/fixtures.ts'

test('a field invented in Settings becomes a column you can filter by', async ({ page }) => {
  await page.goto('/settings/contacts/attributes')

  await page.getByRole('button', { name: 'Add new' }).click()

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'Create new field' })).toBeVisible()

  await dialog.getByLabel('Title').fill('Ticket size')

  // The slug is derived, not typed. If that ever stops happening the assertion fails here rather
  // than three steps later as "no such column".
  await expect(dialog.getByLabel('Slug')).toHaveValue('ticket_size')

  await dialog.getByRole('button', { name: 'Save', exact: true }).click()

  await expect(dialog).toBeHidden()
  await expect(page.getByRole('row', { name: /Ticket size/ })).toBeVisible()

  // --- it appears as a column -------------------------------------------------------------------

  await page.goto('/contacts')

  // A new attribute is not in the default nine columns, so it starts life in the Columns picker's
  // "Hidden" half. That it is *there at all*, unprompted, is the thing being tested.
  await page.getByRole('button', { name: /^Columns \d+\/\d+$/ }).click()
  await page.getByRole('checkbox', { name: 'Show Ticket size' }).click()
  await page.keyboard.press('Escape')

  await expect(page.getByRole('columnheader').filter({ hasText: 'Ticket size' })).toBeVisible()

  // --- and you can filter by it -----------------------------------------------------------------

  // With no contacts at all the table already shows an empty state, and *which* one it shows is the
  // assertion: "No contacts yet" means the filter did nothing, "Nothing matches" means it applied.
  await expect(page.getByText('No contacts yet')).toBeVisible()

  await page.getByRole('button', { name: 'Add filter' }).click()

  // `getByRole`, not `getByLabel`: cmdk's input is a combobox, and its aria-label is not a label
  // association Playwright will resolve. The accessible name is the same either way.
  await page.getByRole('combobox', { name: 'Find a field' }).fill('Ticket size')
  await page.getByRole('option', { name: 'Ticket size' }).click()
  await page.getByRole('textbox', { name: 'Value' }).fill('50k')
  await page.getByRole('button', { name: 'Done' }).click()

  await expect(page).toHaveURL(/filter=/)
  await expect(page.getByText('Nothing matches')).toBeVisible()
})
