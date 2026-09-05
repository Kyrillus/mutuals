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

// All six pass. Four of them were `test.fixme` when this file was written, because they described
// defects that were measured and not yet fixed; the assertions were left as the specification and
// the fixes were made against them rather than the other way round. What each one turned out to be
// is worth knowing, because only one was where its FIXME said it was:
//
//   - the table's "Try again" refetched the schema and not the rows, so it swapped one failure
//     screen for another;
//   - the dashboard was already fixed -- the test addressed the sidebar's "Contacts" link instead
//     of the card's, because `.first()` picks the earlier one in the DOM;
//   - both write tests failed on a *double toast*, which was a double PATCH: the detail sidebar's
//     editor had no commit latch, so Enter wrote every edit twice. See `attribute-sidebar.tsx`.

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

test('a table whose schema cannot be fetched says so, and recovers', async ({ page }) => {
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

test('the dashboard admits it has no numbers instead of loading for ever', async ({ page }) => {
  await refuseEverything(page)
  await page.goto('/')

  // A skeleton is a promise that a number is coming. With the API gone, every card on this page
  // pulsed indefinitely — the one screen where "still loading" and "never" looked the same.
  //
  // Scoped to the Key numbers row: `getByRole('link', { name: /^Contacts/ })` also matches the
  // sidebar's navigation link, and `.first()` picks that one because it is earlier in the DOM. The
  // assertion is unchanged; it just addresses the card it was always about.
  const cards = page.getByTestId('key-numbers')
  await expect(cards.getByRole('link', { name: /^Contacts/ })).toContainText('—')
  await expect(cards.getByRole('link', { name: /^Overdue/ })).toContainText('—')
  await expect(page.getByText('Could not reach the server').first()).toBeVisible()
})

test('an edit that fails on the way out is rolled back, and says why', async ({ page }) => {
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

test('a write that hangs is given up on rather than left pending', async ({ page }) => {
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
