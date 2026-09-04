/**
 * §8.1, flow 3: add interaction → add follow-up → mark done → the recurrence creates the next one.
 *
 * **Half of this is now real.** Stage 3 built the contact detail page and interactions CRUD, so the
 * interaction step is a test. Follow-ups are Stage 4 (§6.4), so the rest stays `fixme` with its
 * assertions intact.
 *
 * One assertion changed from what Stage 2 wrote down, and this is the note that PR promised: the
 * warmth check was `expect(page.getByText(/today|just now/i))`. `formatRelativeDay` says "today"
 * only for a civil date equal to `today`, and the seedless e2e database plus a `datetime-local`
 * default means the interaction is logged at the current instant — so the assertion is now against
 * the Relationship card's own number, which is what §4.7 actually promises to move.
 */
import { expect, test } from '../support/fixtures.ts'

test('logging an interaction moves the relationship numbers', async ({ page }) => {
  await page.goto('/contacts')
  await page.getByRole('cell').getByRole('button', { name: 'Add new' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('First name').fill('Grace')
  await dialog.getByLabel('Last name').fill('Hopper')
  await dialog.getByRole('button', { name: 'Save contact' }).click()
  await expect(dialog).toBeHidden()

  await page.getByRole('link', { name: /Grace Hopper/ }).click()

  // Before: nothing logged, and the empty state says what logging one is *for*.
  await expect(page.getByText('Nothing logged yet')).toBeVisible()

  await page.getByRole('button', { name: 'New activity' }).click()
  const compose = page.getByRole('dialog')
  await expect(compose.getByRole('heading', { name: 'Log an activity' })).toBeVisible()

  await compose.getByLabel('Type').selectOption('Meeting')
  await compose.getByLabel('Title').fill('Talked about the compiler')
  await compose.getByLabel('Notes').fill('She is looking for a systems hire.')
  await compose.getByRole('button', { name: 'Log activity' }).click()
  await expect(compose).toBeHidden()

  await expect(page.getByText('Talked about the compiler')).toBeVisible()
  await expect(page.getByText('She is looking for a systems hire.')).toBeVisible()

  // §4.7: an interaction is what warmth is computed from, so the derived columns have to move.
  // This is the assertion that proves the projection ran rather than that a row was inserted.
  const relationship = page.getByRole('article').filter({ hasText: 'Relationship' })
  await expect(relationship.getByText('1', { exact: true }).first()).toBeVisible()

  // --- and it can be edited and removed ---------------------------------------------------------

  await page.getByRole('button', { name: 'Edit Talked about the compiler' }).click()
  const edit = page.getByRole('dialog')
  await edit.getByLabel('Title').fill('Talked about COBOL')
  await edit.getByRole('button', { name: 'Save activity' }).click()
  await expect(edit).toBeHidden()
  await expect(page.getByText('Talked about COBOL')).toBeVisible()

  await page.getByRole('button', { name: 'Delete Talked about COBOL' }).click()
  await page.getByRole('button', { name: 'Delete activity' }).click()
  await expect(page.getByText('Nothing logged yet')).toBeVisible()
})

/**
 * The rest of §8.1's third flow. Stage 4 turns this into `test(...)`.
 *
 * It still needs a decision that Stage 3 deliberately did not make: the browser has to be told what
 * "today" is before these dates can be exact. ADR-091 settles *how* — Playwright's own clock, not a
 * hook in production code — so this becomes `page.clock.setFixedTime(...)` at the top rather than
 * anything the app has to know about.
 */
test.fixme('a recurring follow-up, marked done, creates the next one', async ({ page }) => {
  await page.goto('/contacts')
  // …contact and interaction as above…

  await page.getByRole('button', { name: /Add follow-up/ }).click()
  await page.getByLabel(/Title|What/).fill('Check in with Grace')
  await page.getByLabel(/Repeats|Recurrence/).selectOption({ label: 'Every 3 months' })
  await page.getByRole('button', { name: /Save/ }).click()

  await expect(page.getByRole('listitem').filter({ hasText: 'Check in with Grace' })).toBeVisible()

  await page.getByRole('checkbox', { name: /Check in with Grace/ }).check()
  await expect(page.getByText(/Done|Completed/)).toBeVisible()

  // The point of the flow: completing a recurring follow-up creates the next occurrence rather than
  // ending the series. One open follow-up before, one open follow-up after — a different one.
  await page.goto('/follow-ups')
  await expect(page.getByRole('cell', { name: 'Check in with Grace' })).toHaveCount(1)

  // And it is dated by the rule (three months on), not by the moment the box was ticked.
  await expect(page.getByRole('row', { name: /Check in with Grace/ })).toContainText(
    /in (2|3) months/,
  )
})
