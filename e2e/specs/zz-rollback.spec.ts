/** TEMPORARY. */
import { expect, test, type Page } from '../support/fixtures.ts'

async function addContact(page: Page, first: string, last: string): Promise<void> {
  await page.goto('/contacts')
  await page.getByRole('button', { name: 'Add new' }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('First name').fill(first)
  await dialog.getByLabel('Last name').fill(last)
  await dialog.getByRole('button', { name: 'Save contact' }).click()
  await expect(dialog).toBeHidden()
}

test('probe rollback', async ({ page }) => {
  await addContact(page, 'Grace', 'Hopper')
  await page.getByRole('link', { name: 'Grace Hopper' }).click()

  page.on('request', (r) => {
    if (r.method() === 'PATCH') console.log('PATCH ->', r.url())
  })
  page.on('requestfailed', (r) => {
    if (r.method() === 'PATCH') console.log('PATCH failed', r.failure()?.errorText)
  })
  page.on('response', (r) => {
    if (r.request().method() === 'PATCH') console.log('PATCH resp', r.status())
  })

  await page.route('**/api/v1/contacts/*', async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.continue()
      return
    }
    await new Promise((r) => setTimeout(r, 600))
    await route.abort('connectionrefused')
  })

  await page.getByRole('button', { name: 'Edit City' }).click()
  const input = page.getByRole('textbox', { name: 'City' })
  await input.fill('Munich')
  await input.press('Enter')
  for (const wait of [200, 500, 1000, 2000, 4000]) {
    await page.waitForTimeout(wait)
    console.log(
      wait,
      'cell =',
      JSON.stringify(await page.getByRole('button', { name: 'Edit City' }).innerText()),
    )
  }
  console.log('toasts:', await page.locator('[data-sonner-toast]').allInnerTexts())
  expect(true).toBe(true)
})
