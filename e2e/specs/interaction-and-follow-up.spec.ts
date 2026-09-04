/**
 * §8.1, flow 3 (the rest of it): add interaction → add follow-up → mark done → the recurrence
 * creates the next one.
 *
 * **`fixme`, not `skip`.** `create-contact.spec.ts` covers the first step today. The contact detail
 * page is Stage 3 (§6.5) and follow-ups are Stage 4 (§6.4), so the three steps after it have nothing
 * to click yet.
 *
 * The domain behind this is already built and unit-tested — recurrence computation lives in
 * `packages/core` and has been since Stage 1. What is missing is only the screen. So the assertions
 * below are about what the *user* sees, and deliberately not about the maths: that a completed
 * recurring follow-up does not simply vanish, and that the next occurrence is dated from the rule
 * rather than from the day the box was ticked.
 *
 * A fixed clock will be needed here. `now`, `today` and `timeZone` are injected parameters
 * everywhere in the domain (CLAUDE.md), but this drives the real UI, so Stage 4 has to decide how
 * the browser learns what "today" is before the date assertions below can be exact.
 */
import { expect, test } from '../support/fixtures.ts'

test.fixme('an interaction, then a recurring follow-up, then the next one', async ({ page }) => {
  await page.goto('/contacts')

  await page.getByRole('button', { name: 'Add new', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('First name').fill('Grace')
  await dialog.getByLabel('Last name').fill('Hopper')
  await dialog.getByRole('button', { name: 'Save contact' }).click()

  await page.getByRole('link', { name: 'Grace Hopper' }).click()

  // --- an interaction ---------------------------------------------------------------------------

  await page.getByRole('button', { name: /Log interaction|Add interaction/ }).click()
  await page.getByLabel('Type').selectOption({ label: 'Coffee' })
  await page.getByLabel('Notes').fill('Talked about the compiler.')
  await page.getByRole('button', { name: /Save/ }).click()

  await expect(page.getByText('Talked about the compiler.')).toBeVisible()

  // §4.7: an interaction is what warmth is computed from, so the derived column has to move. This
  // is the assertion that proves the projection ran, not just that a row was inserted.
  await expect(page.getByText(/Last interaction/)).toBeVisible()
  await expect(page.getByText(/today|just now/i)).toBeVisible()

  // --- a recurring follow-up --------------------------------------------------------------------

  await page.getByRole('button', { name: /Add follow-up/ }).click()
  await page.getByLabel(/Title|What/).fill('Check in with Grace')
  await page.getByLabel(/Repeats|Recurrence/).selectOption({ label: 'Every 3 months' })
  await page.getByRole('button', { name: /Save/ }).click()

  await expect(page.getByRole('listitem').filter({ hasText: 'Check in with Grace' })).toBeVisible()

  // --- mark it done, and the next one appears ---------------------------------------------------

  await page.getByRole('checkbox', { name: /Check in with Grace/ }).check()

  await expect(page.getByText(/Done|Completed/)).toBeVisible()

  // The point of the flow: completing a recurring follow-up creates the next occurrence rather than
  // ending the series. One open follow-up before, one open follow-up after — a different one.
  await page.goto('/follow-ups')
  await expect(page.getByRole('cell', { name: 'Check in with Grace' })).toHaveCount(1)
  await expect(page.getByText('Rows: 1')).toBeVisible()

  // And it is dated by the rule (three months on), not by the moment the box was ticked.
  await expect(page.getByRole('row', { name: /Check in with Grace/ })).toContainText(
    /in (2|3) months/,
  )
})
