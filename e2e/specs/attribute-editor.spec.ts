/**
 * The attribute editor's two long-standing debts, paid and then fenced with tests.
 *
 * 1. **A popover inside a dialog.** Radix's Dialog locks scrolling with `react-remove-scroll`,
 *    which allows wheel events only inside its own subtree. The twelve-item Type picker was
 *    portalled to `document.body`, so it rendered, scrolled in the DOM, and refused to move under
 *    the mouse. Simon found it on 2026-09-04; it was fixed by publishing the dialog's content node
 *    and portalling into it (`useDialogContainer`) — and the regression test was **abandoned**,
 *    because selecting the Type control needed `nth(2)` and a test that counts controls breaks the
 *    day somebody adds a field. This is that test, now that the control has a name.
 *
 * 2. **The name itself.** `FieldRow` renders a `<label for>`, and the Type and Group controls are
 *    buttons. Chromium does resolve that association — measured, rather than assumed — so the name
 *    was "Type *", asterisk and all, with the current value nowhere in it. Both halves are wrong:
 *    the asterisk is decoration, and a picker that never announces what it is set to is a picker a
 *    screen-reader user has to open to read.
 */
import { expect, test } from '../support/fixtures.ts'

test('the Type and Group controls announce the field and its value', async ({ page }) => {
  await page.goto('/settings/contacts/attributes')
  await page.getByRole('button', { name: 'Add new' }).click()

  const dialog = page.getByRole('dialog', { name: 'Create new field' })
  await expect(dialog).toBeVisible()

  // "Type Short text", the way a native `<select>` announces itself — not "Short text", and not
  // "Type *", which is how a decorative asterisk gets read out as part of a field's name.
  const type = dialog.getByRole('button', { name: 'Type Short text' })
  await expect(type).toBeVisible()
  await expect(type).toHaveAttribute('aria-required', 'true')

  await expect(dialog.getByRole('button', { name: 'Group No group' })).toBeVisible()

  // The required marker is out of the name, and said in a way software can act on instead.
  const title = dialog.getByRole('textbox', { name: 'Title', exact: true })
  await expect(title).toBeVisible()
  await expect(title).toHaveAttribute('aria-required', 'true')
  await expect(dialog.getByRole('textbox', { name: 'Description', exact: true })).toBeVisible()
})

test('the Type picker opens inside the dialog and scrolls under the mouse', async ({ page }) => {
  await page.goto('/settings/contacts/attributes')
  await page.getByRole('button', { name: 'Add new' }).click()

  const dialog = page.getByRole('dialog', { name: 'Create new field' })
  const type = dialog.getByRole('button', { name: 'Type Short text' })

  await type.focus()
  await page.keyboard.press('Enter')

  const search = page.getByRole('combobox', { name: 'Search types' })
  await expect(search).toBeVisible()

  // The fix, asserted directly: the popover is a *descendant of the dialog*, which is the only
  // reason `react-remove-scroll` lets the wheel through to it.
  const insideDialog = await page.evaluate(() => {
    const content = document.querySelector('[data-slot="dialog-content"]')
    const list = document.querySelector('[cmdk-list]')
    return content !== null && list !== null && content.contains(list)
  })
  expect(insideDialog, 'the type picker is portalled outside the dialog again').toBe(true)

  // And the symptom, asserted the way it was reported: put the pointer over the list and turn the
  // wheel. Scrolling the DOM node by script would pass even with the bug present.
  const list = page.locator('[cmdk-list]')
  const box = await list.boundingBox()
  expect(box).not.toBeNull()
  if (box === null) return

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, 300)

  await expect
    .poll(() => list.evaluate((element) => element.scrollTop), { timeout: 5_000 })
    .toBeGreaterThan(0)
})

test('a type chosen in the popover lands on the field it is saved with', async ({ page }) => {
  await page.goto('/settings/contacts/attributes')
  await page.getByRole('button', { name: 'Add new' }).click()

  const dialog = page.getByRole('dialog', { name: 'Create new field' })
  await dialog.getByRole('textbox', { name: 'Title', exact: true }).fill('Ticket size')

  await dialog.getByRole('button', { name: 'Type Short text' }).click()
  await page.getByRole('combobox', { name: 'Search types' }).fill('Number')
  await page.getByRole('option', { name: 'Number' }).first().click()

  // The trigger's name is its value, so this assertion is the round trip: chosen, stored, shown.
  await expect(dialog.getByRole('button', { name: 'Type Number' })).toBeVisible()

  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(dialog).toBeHidden()

  const row = page.getByRole('row', { name: /Ticket size/ })
  await expect(row).toBeVisible()
  await expect(row).toContainText('Number')

  // And editing it back shows the locked type with the same name, rather than a bare value.
  await page.getByRole('button', { name: 'Actions for Ticket size' }).click()
  await page.getByRole('menuitem', { name: /Edit/ }).click()
  const editing = page.getByRole('dialog', { name: 'Edit field' })
  await expect(editing.getByRole('group', { name: 'Type Number' })).toBeVisible()
})
