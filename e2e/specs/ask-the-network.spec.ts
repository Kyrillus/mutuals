/**
 * §4.8 and §6.1: a natural-language question becomes a filter over the existing API, runs, and the
 * answer shows *which filter it ran*.
 *
 * Everything below the socket to the model is real here — the transport, the strict
 * `response_format`, the Zod re-validation, `buildFilterSet`, the query compiler and the `llm_call`
 * trace. Only the model's judgement comes from `support/model-stub.mjs`, which is the one thing an
 * end-to-end test could never assert anyway.
 *
 * The last assertion is the one that makes the feature trustworthy rather than impressive: the
 * filter shown under "How I searched" opens as an ordinary table, with the ordinary filter bar,
 * where the user can correct it.
 */
import type { Page } from '@playwright/test'

import { expect, test } from '../support/fixtures.ts'

async function addContact(page: Page, first: string, last: string, city: string): Promise<void> {
  await page.goto('/contacts')
  // The toolbar's `Add new`, not the empty state's: the empty state is gone by the second contact,
  // and `.first()` is the toolbar because it is above the table.
  await page.getByRole('button', { name: 'Add new' }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('First name').fill(first)
  await dialog.getByLabel('Last name').fill(last)
  await dialog.getByLabel('City').fill(city)
  await dialog.getByRole('button', { name: 'Save contact' }).click()
  await expect(dialog).toBeHidden()
}

test('a question becomes a filter, runs, and says how it searched', async ({ page }) => {
  await addContact(page, 'Anna', 'Berger', 'Munich')
  await addContact(page, 'Ben', 'Roth', 'Hamburg')

  await page.goto('/')

  const input = page.getByLabel('Ask the network')
  await expect(input).toBeEnabled()
  await input.fill('Who do I know in Munich?')
  await page.getByRole('button', { name: 'Ask' }).click()

  const answer = page.getByTestId('ask-answer')
  await expect(answer).toBeVisible()
  // The count is composed in code around the real number of rows: the model is never asked for one
  // and so can never be wrong about it (ADR-103).
  await expect(answer).toContainText('Found 1 contact matching contacts in Munich.')

  // §4.8: the matching records, as clickable chips.
  await expect(answer.getByRole('link', { name: 'Anna Berger' })).toBeVisible()
  await expect(answer.getByRole('link', { name: 'Ben Roth' })).toBeHidden()

  // §6.1: the executed filter, in a collapsible "How I searched".
  await answer.getByRole('button', { name: 'How I searched' }).click()
  await expect(answer).toContainText('City')
  await expect(answer).toContainText('Munich')

  // And it is the ordinary filter model, so it opens as an ordinary table.
  await answer.getByRole('link', { name: 'Open as a table' }).click()
  await expect(page).toHaveURL(/\/contacts\?.*filter=/)
  await expect(page.getByRole('row', { name: /Anna Berger/ })).toBeVisible()
  await expect(page.getByRole('row', { name: /Ben Roth/ })).toBeHidden()
  // The filter arrived as a chip in the filter bar, reading as the same sentence the answer showed
  // and editable like any other — which is the whole reason `ask` answers with the filter model.
  await expect(page.getByRole('button', { name: 'City is Munich', exact: true })).toBeVisible()
})

test('a chip opens the contact it names', async ({ page }) => {
  await addContact(page, 'Anna', 'Berger', 'Munich')

  await page.goto('/')
  await page.getByLabel('Ask the network').fill('Anyone in Munich?')
  await page.getByRole('button', { name: 'Ask' }).click()

  await page.getByTestId('ask-answer').getByRole('link', { name: 'Anna Berger' }).click()
  await expect(page).toHaveURL(/\/contacts\/[0-9a-f-]{36}$/)
  await expect(page.getByRole('heading', { name: 'Anna Berger', level: 1 })).toBeVisible()
})

test('a question it cannot express is answered in words, not with an error', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Ask the network').fill('What is the weather like?')
  await page.getByRole('button', { name: 'Ask' }).click()

  const answer = page.getByTestId('ask-answer')
  await expect(answer).toContainText('I have no field for that in your network.')
  // Nothing ran, so there is no filter to show — an empty one would mean "everyone".
  await expect(answer.getByRole('button', { name: 'How I searched' })).toBeHidden()
})
