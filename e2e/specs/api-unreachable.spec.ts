/**
 * What the app says when its server is not there.
 *
 * The existing error tests all cover the case where the API answers — a 400 with a problem
 * document, a field-level rejection. This is the other one, and it is the one Simon will actually
 * meet: `pnpm dev` not running, the machine asleep, a laptop that woke up on a different network.
 *
 * **The failures here were measured before they were simulated.** With Fastify killed and the built
 * SPA served by `vite preview`, the browser does not see a dropped socket at all — Vite's `/api`
 * proxy answers **502 Bad Gateway** with an HTML body. The app used to put that string on screen:
 * "The field definitions could not be loaded: 502 Bad Gateway", a stat card that pulsed for ever,
 * and an inline edit whose toast read "Could not save City — 502 Bad Gateway". So both shapes are
 * exercised below: the gateway status, and the refused connection you get in production, where
 * Fastify serves the SPA itself.
 */
import { expect, test, type Page } from '../support/fixtures.ts'

// Four of these are `test.fixme`. They are not aspirational: each was measured against a killed
// Fastify before it was written, and each describes a defect that is still in the app. The agent
// that found them was stopped before it could fix them, so the assertions stand as the
// specification. Un-fixme them one at a time as the fixes land -- see docs/HANDOFF.md.

/** Everything the SPA asks for, gone. `**` so the versioned prefix is not spelled out twice. */
const API = '**/api/v1/**'

async function refuseEverything(page: Page): Promise<void> {
  await page.route(API, async (route) => {
    await route.abort('connectionrefused')
  })
}

async function gatewayFailure(page: Page): Promise<void> {
  await page.route(API, async (route) => {
    await route.fulfill({
      status: 502,
      contentType: 'text/html',
      body: '<html><body><h1>502 Bad Gateway</h1></body></html>',
    })
  })
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

// FIXME (Stage 7): the schema-fetch failure still renders the raw status text instead of one sentence.
test.fixme('a table whose schema cannot be fetched says so, and recovers', async ({ page }) => {
  await refuseEverything(page)
  await page.goto('/contacts')

  const message = page.getByRole('heading', { name: 'This table could not be loaded' })
  await expect(message).toBeVisible()
  await expect(page.getByText('Could not reach the server')).toBeVisible()

  // "Try again" has to actually try again — not reload the page, and not do nothing.
  await page.unroute(API)
  await page.getByRole('button', { name: 'Try again' }).click()

  await expect(message).toBeHidden()
  await expect(page.getByRole('row', { name: /No contacts yet/ })).toBeVisible()
})

test('a proxy answering 502 is reported as a server that is not there', async ({ page }) => {
  // What `vite preview` and `pnpm dev` really do when Fastify is stopped. Every failure this API
  // produces carries an RFC 9457 body, so a bare 502 did not come from it.
  await gatewayFailure(page)
  await page.goto('/contacts')

  await expect(page.getByRole('heading', { name: 'This table could not be loaded' })).toBeVisible()
  await expect(page.getByText('Could not reach the server')).toBeVisible()
  await expect(page.getByText('502 Bad Gateway')).toBeHidden()
})

test('a page whose loader cannot reach the server offers the way back', async ({ page }) => {
  await refuseEverything(page)
  await page.goto('/contacts/00000000-0000-4000-8000-000000000000')

  await expect(page.getByRole('heading', { name: 'The app cannot reach its server' })).toBeVisible()
  // It says where the data is, because "everything is gone" is the reasonable fear here.
  await expect(page.getByText(/database on this machine, so nothing is lost/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible()
})

// FIXME (Stage 7): the dashboard stat cards still pulse for ever rather than admitting they have no numbers.
test.fixme('the dashboard admits it has no numbers instead of loading for ever', async ({
  page,
}) => {
  await refuseEverything(page)
  await page.goto('/')

  // A skeleton is a promise that a number is coming. With the API gone, every card on this page
  // pulsed indefinitely — the one screen where "still loading" and "never" looked the same.
  const contacts = page.getByRole('link', { name: /^Contacts/ }).first()
  await expect(contacts).toContainText('—')
  await expect(page.getByText('Could not reach the server').first()).toBeVisible()
})

// FIXME (Stage 7): the rollback happens, but the toast still carries the transport error rather than a sentence.
test.fixme('an edit that fails on the way out is rolled back, and says why', async ({ page }) => {
  await addContact(page, 'Grace', 'Hopper')
  await page.getByRole('link', { name: 'Grace Hopper' }).click()

  // Only the write is refused, and only after a beat — so the optimistic value is on screen long
  // enough to assert that it was ever there. A rollback nobody can see is not a rollback.
  await page.route('**/api/v1/contacts/*', async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.continue()
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 600))
    await route.abort('connectionrefused')
  })

  await page.getByRole('button', { name: 'Edit City' }).click()
  const input = page.getByRole('textbox', { name: 'City' })
  await input.fill('Munich')
  await input.press('Enter')

  // ADR-049's optimistic patch: the new value is on screen before the server has said anything.
  await expect(page.getByRole('button', { name: 'Edit City' })).toHaveText('Munich')

  // And then the server never says anything, so it goes back.
  await expect(page.getByRole('button', { name: 'Edit City' })).toHaveText('—')

  const toast = page.getByText('Could not save City')
  await expect(toast).toBeVisible()
  await expect(page.getByText('Could not reach the server')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible()
})

// FIXME (Stage 7): nothing gives up on a hung write yet — there is no client-side deadline.
test.fixme('a write that hangs is given up on rather than left pending', async ({ page }) => {
  // The client deadline is 20 seconds (`DEFAULT_TIMEOUT_MS`), so this test outlives the default
  // 30-second budget on purpose. It is the only place the whole chain — deadline, rollback, a
  // sentence about waiting — is exercised against a real socket that simply never answers.
  test.setTimeout(60_000)

  await addContact(page, 'Grace', 'Hopper')
  await page.getByRole('link', { name: 'Grace Hopper' }).click()

  await page.route('**/api/v1/contacts/*', async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.continue()
      return
    }
    // Never fulfilled, never aborted: the request stays open until the client gives up.
    await new Promise(() => {
      /* deliberately never resolves */
    })
  })

  await page.getByRole('button', { name: 'Edit City' }).click()
  const input = page.getByRole('textbox', { name: 'City' })
  await input.fill('Munich')
  await input.press('Enter')

  await expect(page.getByRole('button', { name: 'Edit City' })).toHaveText('Munich')

  await expect(page.getByText('Could not save City')).toBeVisible({ timeout: 40_000 })
  await expect(page.getByText(/did not answer within 20 seconds/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Edit City' })).toHaveText('—')
})
