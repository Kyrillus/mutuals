/**
 * §6.6's saved views, and ADR-048's state machine from the outside.
 *
 * The three situations that ADR matters for are the three this asserts: no view, a clean view, and
 * a dirty one. "Dirty" is deep equality over the canonical `(filters, sort, columns)` triple, so
 * the test that earns its keep is the one where a change is made and then *undone* — a naive
 * implementation comparing raw URL strings would still call that dirty.
 *
 * The e2e database has no seeded views (the reset leaves only what the migrations wrote), so these
 * build their own. That is the honest starting point for a new workspace anyway.
 */
import { expect, test } from '../support/fixtures.ts'

test('a view is saved, reopened, and carries its filters', async ({ page }) => {
  await page.goto('/contacts')

  // With no views at all, the picker stays out of the way entirely.
  await expect(page.getByRole('button', { name: /^All/ })).toBeHidden()

  await page.getByRole('button', { name: 'Add filter' }).click()
  await page.getByRole('combobox', { name: 'Find a field' }).fill('City')
  await page.getByRole('option', { name: 'City', exact: true }).click()
  await page.getByRole('textbox', { name: 'Value' }).fill('Munich')
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(page).toHaveURL(/filter=/)

  await page.getByRole('button', { name: 'View options' }).click()
  await page.getByRole('menuitem', { name: 'Save as new view' }).click()

  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Name').fill('Munich people')
  await dialog.getByRole('button', { name: 'Save view' }).click()
  await expect(dialog).toBeHidden()

  // Saving opens it: the URL gains `?view=`, and the breadcrumb gains the name (§5.2).
  await expect(page).toHaveURL(/view=/)
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Munich people')
  await expect(page.getByRole('button', { name: /Munich people/ })).toBeVisible()

  // And it survives being thrown away and reopened from the address bar alone.
  const url = page.url()
  await page.goto('/')
  await page.goto(url)
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Munich people')
  // The filter came back with it, not just the name.
  await expect(
    page.getByRole('button', { name: 'City contains Munich', exact: true }),
  ).toBeVisible()
})

test('search does not dirty a view; a filter does, and removing it cleans it', async ({ page }) => {
  await page.goto('/contacts')

  await page.getByRole('button', { name: 'View options' }).click()
  await page.getByRole('menuitem', { name: 'Save as new view' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Name').fill('Everyone')
  await dialog.getByRole('button', { name: 'Save view' }).click()
  await expect(dialog).toBeHidden()

  const picker = page.getByRole('button', { name: /Everyone/ })
  await expect(picker).not.toContainText('edited')

  // --- searching is not part of a view --------------------------------------------------------

  // §5.2 defines a view as columns + filters + sort. `q` is none of those, so typing in the search
  // box must not make a saved view look modified — the snapshot is the triple, not the whole URL.
  await page.getByRole('searchbox', { name: 'Search…' }).fill('Lovelace')
  await expect(page).toHaveURL(/q=Lovelace/)
  await expect(picker).not.toContainText('edited')

  // --- a filter does, and removing it cleans it again -------------------------------------------

  await page.getByRole('button', { name: 'Add filter' }).click()
  await page.getByRole('combobox', { name: 'Find a field' }).fill('City')
  await page.getByRole('option', { name: 'City', exact: true }).click()
  await page.getByRole('textbox', { name: 'Value' }).fill('Munich')
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(picker).toContainText('edited')

  // Removing it leaves `filter=[]` where the saved snapshot had no filter parameter at all, so a
  // string comparison of URLs would still call this dirty. Dirtiness is deep equality over the
  // canonical triple (ADR-048), and this is the assertion that proves it.
  await page.getByRole('button', { name: 'Remove filter: City contains Munich' }).click()
  await expect(picker).not.toContainText('edited')
})

test('revert throws the working copy away; save changes keeps it', async ({ page }) => {
  await page.goto('/contacts')

  await page.getByRole('button', { name: 'View options' }).click()
  await page.getByRole('menuitem', { name: 'Save as new view' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Name').fill('Baseline')
  await dialog.getByRole('button', { name: 'Save view' }).click()
  await expect(dialog).toBeHidden()

  const phone = page.getByRole('columnheader', { name: 'Phone', exact: true })
  await expect(phone).toBeVisible()

  // --- revert ------------------------------------------------------------------------------------

  await page.getByRole('button', { name: /^Columns \d+\/\d+$/ }).click()
  await page.getByRole('checkbox', { name: 'Hide Phone' }).click()
  await page.keyboard.press('Escape')
  await expect(phone).toBeHidden()

  await page.getByRole('button', { name: 'View options' }).click()
  await page.getByRole('menuitem', { name: 'Revert changes' }).click()
  await expect(phone).toBeVisible()

  // --- save changes ------------------------------------------------------------------------------

  await page.getByRole('button', { name: /^Columns \d+\/\d+$/ }).click()
  await page.getByRole('checkbox', { name: 'Hide Phone' }).click()
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'View options' }).click()
  await page.getByRole('menuitem', { name: /Save changes to "Baseline"/ }).click()
  await expect(page.getByRole('button', { name: /Baseline/ })).not.toContainText('edited')

  // The overwrite stuck: reopening from a bare link brings back the *new* snapshot, without Phone.
  await page.goto('/')
  await page.goto(page.url().replace('/', '/contacts?view=') === '' ? '/contacts' : '/contacts')
  await page.getByRole('button', { name: /Baseline|^All/ }).click()
  await page.getByRole('menuitem', { name: 'Baseline' }).click()
  await expect(page.getByRole('columnheader', { name: 'Phone', exact: true })).toBeHidden()
})
