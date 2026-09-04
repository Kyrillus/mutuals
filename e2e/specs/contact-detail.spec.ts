/**
 * §6.5's contact detail page, and §4.5's history popover — the screen the whole data model was
 * built for.
 *
 * The history assertion is the one that matters. `fact` has been append-only since Stage 1 and
 * nothing could read it; this proves that a value typed in the sidebar arrives in the log with its
 * provenance attached, and that a *second* value supersedes rather than overwrites the first.
 */
import type { Page } from '@playwright/test'

import { expect, test } from '../support/fixtures.ts'

async function createContact(page: Page, first: string, last: string) {
  await page.goto('/contacts')
  await page.getByRole('cell').getByRole('button', { name: 'Add new' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('First name').fill(first)
  await dialog.getByLabel('Last name').fill(last)
  await dialog.getByRole('button', { name: 'Save contact' }).click()
  await expect(dialog).toBeHidden()
}

test('a contact opens from the table and shows its four tabs', async ({ page }) => {
  await createContact(page, 'Ada', 'Lovelace')

  await page.getByRole('link', { name: /Ada Lovelace/ }).click()

  await expect(page).toHaveURL(/\/contacts\/[0-9a-f-]{36}$/)
  await expect(page.getByRole('heading', { name: 'Ada Lovelace', level: 1 })).toBeVisible()

  // The breadcrumb is the record's own name, which only the loader can know (§5.1).
  await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText('Ada Lovelace')

  for (const tab of ['Overview', 'Activities', 'Connections', 'Follow-ups']) {
    await expect(page.getByRole('tab', { name: tab })).toBeVisible()
  }

  // Every field the contact can hold, whether or not it has a value (§6.5).
  const sidebar = page.getByRole('complementary', { name: 'All information' })
  await expect(sidebar.getByText('Email', { exact: true })).toBeVisible()
  await expect(sidebar.getByText('City', { exact: true })).toBeVisible()
})

test('editing a field in the sidebar writes a fact, and the history says who said so', async ({
  page,
}) => {
  await createContact(page, 'Grace', 'Hopper')
  await page.getByRole('link', { name: /Grace Hopper/ }).click()

  const sidebar = page.getByRole('complementary', { name: 'All information' })

  await sidebar.getByRole('button', { name: 'Edit City' }).click()
  await sidebar.getByRole('textbox', { name: 'City' }).fill('Arlington')
  await page.keyboard.press('Enter')
  await expect(sidebar.getByText('Arlington')).toBeVisible()

  await sidebar.getByRole('button', { name: 'History of City' }).click()
  const history = page.getByText('City — history')
  await expect(history).toBeVisible()

  // §4.4: the popover says where the value came from, not just what it is.
  await expect(page.getByText('typed by you').first()).toBeVisible()
  await expect(page.getByText('current').first()).toBeVisible()

  await page.keyboard.press('Escape')

  // --- and a second value supersedes rather than replaces ---------------------------------------

  await sidebar.getByRole('button', { name: 'Edit City' }).click()
  await sidebar.getByRole('textbox', { name: 'City' }).fill('Poughkeepsie')
  await page.keyboard.press('Enter')
  await expect(sidebar.getByText('Poughkeepsie')).toBeVisible()

  await sidebar.getByRole('button', { name: 'History of City' }).click()

  // Both, and only the newer one marked current. This is the assertion that proves the log is a
  // log: an overwrite would leave one row here.
  await expect(page.getByText('Poughkeepsie').last()).toBeVisible()
  await expect(page.getByText('Arlington').last()).toBeVisible()
  await expect(page.getByText('current')).toHaveCount(1)
})
