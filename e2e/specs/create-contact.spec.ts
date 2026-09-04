/**
 * §8.1, flow 3 (the half of it Stage 2 can reach): create contact → it appears in the table.
 *
 * The interaction and follow-up half lives in `interaction-and-follow-up.spec.ts` as a `fixme`
 * until Stages 3 and 4 build the pages it needs.
 */
import { expect, test } from '../support/fixtures.ts'

test('a contact created in the dialog appears in the table', async ({ page }) => {
  await page.goto('/contacts')

  // The empty state is part of the flow, not scenery: it is what a new user actually sees first.
  await expect(page.getByText('No contacts yet')).toBeVisible()

  // The empty state's own call to action, not the toolbar's — same label, and this is the one a
  // person with no contacts actually reaches for.
  await page.getByRole('cell').getByRole('button', { name: 'Add new' }).click()

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'Add contact' })).toBeVisible()

  await dialog.getByLabel('First name').fill('Ada')
  await dialog.getByLabel('Last name').fill('Lovelace')
  await dialog.getByLabel('Email').fill('ada@analytical-engine.org')

  await dialog.getByRole('button', { name: 'Save contact' }).click()

  await expect(dialog).toBeHidden()

  // The row, not a cell: the name lands in both the select cell's label and the name cell itself.
  const row = page.getByRole('row', { name: /Ada Lovelace/ })
  await expect(row).toBeVisible()
  await expect(row).toContainText('ada@analytical-engine.org')
  await expect(page.getByText('Rows: 1')).toBeVisible()
})
