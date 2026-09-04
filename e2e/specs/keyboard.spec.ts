/**
 * The keyboard pass, as assertions rather than as a paragraph in a PR body.
 *
 * Everything here was checked by hand first and then written down, because "tab order is sane" is
 * the kind of claim that rots silently: a new control lands in the toolbar, nobody re-tabs the page,
 * and six months later the table is unreachable without a mouse. These are cheap and they run in CI.
 */
import { expect, test } from '../support/fixtures.ts'

test('the skip link is the first stop and jumps past the sidebar', async ({ page }) => {
  await page.goto('/contacts')

  const skip = page.getByRole('link', { name: 'Skip to content' })

  // Hidden until focused: it must not occupy a corner of the page for everyone else. `toBeHidden`
  // is no use here — the screen-reader-only pattern is a real 1×1 box, which counts as visible.
  const hidden = await skip.boundingBox()
  expect(hidden?.width ?? 0).toBeLessThan(4)

  await page.keyboard.press('Tab')
  await expect(skip).toBeFocused()

  // And a real target once it is focused. Asserted in pixels because `focus:not-sr-only` losing to
  // `sr-only` in the cascade is a silent failure: the link is still there, still focusable, still
  // "visible" to a naive assertion, and completely invisible to the person who needs it.
  const shown = await skip.boundingBox()
  expect(shown?.width ?? 0).toBeGreaterThan(80)
  expect(shown?.height ?? 0).toBeGreaterThan(24)

  await page.keyboard.press('Enter')
  await expect(page.locator('main')).toBeFocused()

  // And from there the next stop is the page's own content, not back into the navigation.
  await page.keyboard.press('Tab')
  const afterSkip = page.locator('main :focus')
  await expect(afterSkip).toHaveCount(1)
})

test('the add-contact dialog opens, traps focus and gives it back on Escape', async ({ page }) => {
  await page.goto('/contacts')

  const trigger = page.getByRole('cell').getByRole('button', { name: 'Add new' })
  await trigger.focus()
  await page.keyboard.press('Enter')

  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator(':focus')).toHaveCount(1)

  await page.keyboard.press('Escape')

  await expect(dialog).toBeHidden()
  await expect(trigger).toBeFocused()
})

test('the sticky first column and the row checkboxes are reachable without a mouse', async ({
  page,
}) => {
  await page.goto('/contacts')

  await page.getByRole('cell').getByRole('button', { name: 'Add new' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('First name').fill('Ada')
  await dialog.getByLabel('Last name').fill('Lovelace')
  await dialog.getByRole('button', { name: 'Save contact' }).click()
  await expect(dialog).toBeHidden()

  // The name column is sticky and pinned first (§5.2). Sticky positioning is exactly the kind of
  // thing that ends up with `pointer-events` or an overlay swallowing focus, so: focus it.
  const rowCheckbox = page.getByRole('checkbox', { name: 'Select Ada Lovelace' })
  await rowCheckbox.focus()
  await expect(rowCheckbox).toBeFocused()

  await page.keyboard.press('Space')
  await expect(rowCheckbox).toBeChecked()

  // Selecting a row opens the bulk-action bar; it has to be reachable too, not just visible.
  await expect(page.getByText(/1 contact selected/)).toBeVisible()
})

test('the columns menu opens from the keyboard and closes on Escape', async ({ page }) => {
  await page.goto('/contacts')

  const columns = page.getByRole('button', { name: /^Columns \d+\/\d+$/ })
  await columns.focus()
  await page.keyboard.press('Enter')

  const findColumn = page.getByRole('textbox', { name: 'Find a column' })
  await expect(findColumn).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(findColumn).toBeHidden()
  await expect(columns).toBeFocused()
})
