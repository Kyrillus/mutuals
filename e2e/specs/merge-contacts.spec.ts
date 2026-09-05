/**
 * §6.9: two contacts become one, through the screens a person actually uses.
 *
 * The write path is tested exhaustively in `packages/db` and the preview in `apps/api`. What only a
 * browser can show is the part that makes merge safe rather than merely correct: that the
 * side-by-side offers a radio exactly where there is a real choice, that the confirmation states
 * what is about to move, and that the destructive verb is on the button.
 *
 * Radix menus ignore a synthetic `.click()` — the handover says so, and this spec is why that note
 * exists. Playwright sends real pointer events, so the `⋯` menu opens here and nowhere else.
 */
import type { Page } from '@playwright/test'

import { expect, test } from '../support/fixtures.ts'

/** Two contacts that disagree about one field and complement each other on two more. */
async function seedPair(page: Page): Promise<void> {
  await page.goto('/contacts')

  for (const [first, last, city, email] of [
    ['Anna', 'Berger', 'Munich', 'anna@northstar.example'],
    ['Anna', 'Berger', 'Berlin', ''],
  ] as const) {
    await page.getByRole('button', { name: 'Add new' }).first().click()
    const form = page.getByRole('dialog')
    await form.getByLabel('First name').fill(first)
    await form.getByLabel('Last name').fill(last)
    await form.getByLabel('City').fill(city)
    if (email !== '') await form.getByLabel('Email').fill(email)
    await form.getByRole('button', { name: 'Save contact' }).click()
    await expect(form).toBeHidden()
  }
}

test('merging two contacts keeps one, and lets the user choose what it keeps', async ({ page }) => {
  await seedPair(page)

  /**
   * Open the one with the email. It is the survivor — the record you are looking at is the one that
   * stays, which is what makes "merge into this one" unambiguous.
   *
   * Picked by a value rather than by `.first()`: both contacts are called Anna Berger, which is the
   * whole point of the fixture, so list order decides nothing and the first version of this test
   * silently opened whichever one the table happened to sort first. It then asserted the survivor
   * kept a city it had never had.
   */
  await page
    .getByRole('row')
    .filter({ hasText: 'anna@northstar.example' })
    .getByRole('link', { name: 'Anna Berger' })
    .click()
  await expect(page.getByRole('heading', { name: 'Anna Berger' })).toBeVisible()
  // The city shows twice on a detail page — the header context and the sidebar cell.
  await expect(page.getByText('Munich').first()).toBeVisible()

  await page.getByRole('button', { name: 'Record actions' }).click()
  await page.getByRole('menuitem', { name: /Merge into this one/ }).click()

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText(/Choose the contact to absorb/)).toBeVisible()
  await dialog.getByRole('button', { name: 'Anna Berger' }).first().click()

  // --- the side-by-side -------------------------------------------------------------------------

  await expect(dialog.getByText('(stays)')).toBeVisible()
  await expect(dialog.getByText('(absorbed)')).toBeVisible()

  // City is the one real conflict, so it is the one field with radios.
  const keepBerlin = dialog.getByRole('radio', { name: /City: keep/ }).nth(1)
  await expect(keepBerlin).toBeVisible()

  // Email is on one record only. Taken either way, so no radio — choosing between a value and
  // nothing is not a choice.
  await expect(dialog.getByRole('radio', { name: /Email: keep/ })).toHaveCount(0)

  // The irreversible part is stated before the button, in numbers.
  await expect(dialog.getByText(/This cannot be undone/)).toBeVisible()

  // --- choose the other side and commit -----------------------------------------------------------

  await keepBerlin.check()
  await dialog.getByRole('button', { name: /^Merge and delete/ }).click()

  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(page.getByText(/Merged\./)).toBeVisible()

  // The survivor took the chosen city and kept the email only it had.
  await expect(page.getByText('Berlin').first()).toBeVisible()
  await expect(page.getByText('Munich')).toHaveCount(0)
  await expect(page.getByText('anna@northstar.example').first()).toBeVisible()

  // And there is one Anna Berger left.
  await page.goto('/contacts')
  await expect(page.getByRole('link', { name: 'Anna Berger' })).toHaveCount(1)
})

test('a contact cannot be merged into itself', async ({ page }) => {
  await page.goto('/contacts')
  await page.getByRole('button', { name: 'Add new' }).first().click()
  const form = page.getByRole('dialog')
  await form.getByLabel('First name').fill('Jonas')
  await form.getByLabel('Last name').fill('Weber')
  await form.getByRole('button', { name: 'Save contact' }).click()
  await expect(form).toBeHidden()

  await page.getByRole('link', { name: 'Jonas Weber' }).first().click()
  await page.getByRole('button', { name: 'Record actions' }).click()
  await page.getByRole('menuitem', { name: /Merge into this one/ }).click()

  const dialog = page.getByRole('dialog')
  // The record itself is not offered, so the one thing the server refuses is not reachable.
  await expect(dialog.getByRole('button', { name: 'Jonas Weber' })).toHaveCount(0)
  await expect(dialog.getByText('Nothing else to merge')).toBeVisible()
})
