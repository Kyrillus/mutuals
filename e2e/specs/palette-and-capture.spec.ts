/**
 * §6.10's ⌘K palette and §4.8's quick capture, end to end.
 *
 * Radix menus, popovers and dialogs do not respond to synthetic `.click()` (see `docs/HANDOFF.md`),
 * and neither does a global `keydown` handler driven by anything but real key events — so this is
 * the only place ⌘K itself can be proved to work. That is most of why the spec exists.
 *
 * The capture's assertion that matters is the count: after the preview is on screen, the workspace
 * still holds exactly what it held before. "Nothing is saved before confirmation" is a promise about
 * rows, so it is tested as one.
 */
import type { Page } from '@playwright/test'

import { expect, test } from '../support/fixtures.ts'

/**
 * ⌘K is registered by an effect, so it is only live once the shell has mounted — and `page.goto`
 * resolves before React has run. Pressing the key straight after a navigation delivers a real
 * keydown that nothing is listening for yet, which fails as "the palette never opened" and looks
 * exactly like a broken shortcut. Waiting for the shell's own search control is the signal.
 */
async function pressPalette(page: Page): Promise<void> {
  await expect(page.getByRole('button', { name: 'Search records' })).toBeVisible()
  await page.keyboard.press('ControlOrMeta+k')
}

async function addContact(page: Page, first: string, last: string): Promise<void> {
  await page.goto('/contacts')
  await page.getByRole('button', { name: 'Add new' }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('First name').fill(first)
  await dialog.getByLabel('Last name').fill(last)
  await dialog.getByRole('button', { name: 'Save contact' }).click()
  await expect(dialog).toBeHidden()
}

test('⌘K opens the palette, finds a contact and opens them', async ({ page }) => {
  await addContact(page, 'Anna', 'Berger')
  await page.goto('/follow-ups')

  // The shortcut is a property of the window, not of the contacts page.
  await pressPalette(page)
  const palette = page.getByRole('dialog', { name: 'Search and commands' })
  await expect(palette).toBeVisible()

  await page.keyboard.type('berger')
  await expect(palette.getByText('Contacts', { exact: true })).toBeVisible()
  await palette.getByText('Anna Berger').click()

  await expect(page).toHaveURL(/\/contacts\/[0-9a-f-]{36}$/)
  await expect(page.getByRole('heading', { name: 'Anna Berger', level: 1 })).toBeVisible()
})

test('the palette lists §6.10’s actions and opens the one that is chosen', async ({ page }) => {
  await page.goto('/')
  await pressPalette(page)

  const palette = page.getByRole('dialog', { name: 'Search and commands' })
  for (const label of [
    'Quick capture',
    'New contact',
    'New organization',
    'New follow-up',
    'New interaction',
    'Go to Settings',
  ]) {
    await expect(palette.getByText(label, { exact: true })).toBeVisible()
  }

  await palette.getByText('New organization', { exact: true }).click()
  await expect(palette).toBeHidden()
  // The same dialog the organizations page opens, not a second one that could drift.
  await expect(page.getByRole('heading', { name: 'Add organization' })).toBeVisible()
})

test('Escape closes the palette and leaves the page alone', async ({ page }) => {
  await page.goto('/contacts')
  await pressPalette(page)
  const palette = page.getByRole('dialog', { name: 'Search and commands' })
  await expect(palette).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(palette).toBeHidden()
  await expect(page).toHaveURL(/\/contacts$/)
})

test('a capture previews without saving, then saves what was confirmed', async ({ page }) => {
  await page.goto('/contacts')
  await expect(page.getByText('No contacts yet')).toBeVisible()

  await page.getByRole('button', { name: 'Quick capture' }).click()
  const dialog = page.getByRole('dialog').filter({ hasText: 'Quick capture' })
  await dialog
    .getByLabel('Type what happened. Nothing is saved until you confirm.')
    .fill('Met Anna Berger from Northstar Ventures at Bits & Pretzels, follow up in 3 weeks')
  await dialog.getByRole('button', { name: 'Preview' }).click()

  const preview = page.getByTestId('capture-preview')
  await expect(preview).toBeVisible()
  await expect(preview).toContainText('Anna Berger')
  await expect(preview).toContainText('Northstar Ventures')
  // §6.10: which records are new and which are matched.
  await expect(preview.getByText('New', { exact: true }).first()).toBeVisible()

  // Nothing has been written while the preview is on screen.
  const before = await page.request.get('/api/v1/contacts')
  expect(((await before.json()) as { meta: { total: number } }).meta.total).toBe(0)

  await dialog.getByRole('button', { name: 'Save' }).click()

  await expect(page).toHaveURL(/\/contacts\/[0-9a-f-]{36}$/)
  await expect(page.getByRole('heading', { name: 'Anna Berger', level: 1 })).toBeVisible()
  // The interaction landed on the timeline, and §4.4's provenance says who wrote it.
  await expect(page.getByText('Bits & Pretzels')).toBeVisible()
  await expect(page.getByText(/Added by the assistant/)).toBeVisible()
})

test('a capture card can be switched off before saving', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Quick capture' }).click()
  const dialog = page.getByRole('dialog').filter({ hasText: 'Quick capture' })
  await dialog
    .getByLabel('Type what happened. Nothing is saved until you confirm.')
    .fill('Met Anna Berger from Northstar Ventures')
  await dialog.getByRole('button', { name: 'Preview' }).click()

  await expect(page.getByTestId('capture-preview')).toBeVisible()
  await dialog.getByLabel('Save the organization').uncheck()
  await dialog.getByRole('button', { name: 'Save' }).click()

  await expect(page).toHaveURL(/\/contacts\/[0-9a-f-]{36}$/)
  const organizations = await page.request.get('/api/v1/organizations')
  expect(((await organizations.json()) as { meta: { total: number } }).meta.total).toBe(0)
})

test('§6.5’s summary is written on demand and says when', async ({ page }) => {
  await addContact(page, 'Anna', 'Berger')
  await page.getByRole('link', { name: /Anna Berger/ }).click()

  const card = page.locator('article').filter({ hasText: 'Summary' }).first()
  await expect(card.getByRole('button', { name: 'Write a summary' })).toBeVisible()

  await card.getByRole('button', { name: 'Write a summary' }).click()
  await expect(card).toContainText('An investor at Northstar Ventures in Munich.')
  // §6.5 asks for the timestamp: a summary is stale rather than wrong, and only the date says so.
  await expect(card).toContainText('Written')
  await expect(card.getByRole('button', { name: 'Regenerate' })).toBeVisible()
})
