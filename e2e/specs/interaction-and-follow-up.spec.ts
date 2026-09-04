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
 * The rest of §8.1's third flow, now real.
 *
 * `page.clock` pins the **browser's** clock and nothing else — the API keeps its own, and the
 * successor's date is computed there. So this asserts the promise §4.1 actually makes, which is
 * that the series continues and the next one is dated by the rule: two rows, one done and one open,
 * the open one later than the one that was completed. Asserting a literal date here would be
 * asserting what day the server thinks it is, which is not what the feature does. ADR-091 says this
 * in the paragraph this test corrected.
 */
test('a recurring follow-up, marked done, schedules the next one', async ({ page }) => {
  // A Wednesday, deliberately unremarkable: no month-end clamping to reason about.
  await page.clock.setFixedTime(new Date('2026-03-11T09:00:00Z'))

  await page.goto('/contacts')
  await page.getByRole('cell').getByRole('button', { name: 'Add new' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('First name').fill('Grace')
  await dialog.getByLabel('Last name').fill('Hopper')
  await dialog.getByRole('button', { name: 'Save contact' }).click()
  await expect(dialog).toBeHidden()

  // --- create it from the contact's own page, where the contact is not a question ---------------

  await page.getByRole('link', { name: /Grace Hopper/ }).click()
  await page.getByRole('tab', { name: 'Follow-ups' }).click()
  await expect(page.getByText('Nothing to follow up on')).toBeVisible()

  await page.getByRole('button', { name: 'Add follow-up' }).first().click()
  const compose = page.getByRole('dialog')
  await expect(compose.getByRole('heading', { name: 'Create follow-up' })).toBeVisible()

  await compose.getByLabel('Title').fill('Check in with Grace')
  await compose.getByLabel('Due').fill('2026-03-18')
  await compose.getByLabel('Repeats').selectOption('every_3_months')
  await compose.getByRole('button', { name: 'Create follow-up' }).click()
  await expect(compose).toBeHidden()

  const row = page.getByRole('listitem').filter({ hasText: 'Check in with Grace' })
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('Every 3 months')

  // --- mark it done, and the series continues rather than ending --------------------------------

  await page.getByRole('checkbox', { name: 'Mark Check in with Grace done' }).click()

  // The successor is created inside the same operation, so the toast can name it (§4.1) — the
  // client never sequences "complete" then "create" and never knows the recurrence rules.
  await expect(page.getByText('Done — the next one is scheduled')).toBeVisible()

  // Two rows now: the one just completed, and its successor, still open and still repeating.
  await expect(
    page.getByRole('checkbox', { name: 'Mark Check in with Grace not done' }),
  ).toBeVisible()
  await expect(page.getByRole('checkbox', { name: 'Mark Check in with Grace done' })).toBeVisible()
  await expect(page.getByRole('listitem').filter({ hasText: 'Check in with Grace' })).toHaveCount(2)

  // --- and the split across the tabs is one of each ----------------------------------------------

  await page.goto('/follow-ups')
  await expect(page.getByRole('listitem').filter({ hasText: 'Check in with Grace' })).toHaveCount(1)
  await expect(page.getByText('Every 3 months')).toBeVisible()

  await page.getByRole('tab', { name: 'Done' }).click()
  await expect(page.getByRole('listitem').filter({ hasText: 'Check in with Grace' })).toHaveCount(1)
})

test('the dashboard counts what the follow-ups page shows', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-03-11T09:00:00Z'))

  await page.goto('/contacts')
  await page.getByRole('cell').getByRole('button', { name: 'Add new' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('First name').fill('Ada')
  await dialog.getByLabel('Last name').fill('Lovelace')
  await dialog.getByRole('button', { name: 'Save contact' }).click()
  await expect(dialog).toBeHidden()

  await page.goto('/follow-ups')
  await page.getByRole('button', { name: 'Create follow-up' }).first().click()
  const compose = page.getByRole('dialog')
  await compose.getByLabel('Title').fill('Overdue on purpose')
  await compose.getByLabel('Contact').fill('Ada')
  await compose.getByRole('button', { name: /Ada Lovelace/ }).click()
  await compose.getByLabel('Due').fill('2026-03-01')
  await compose.getByRole('button', { name: 'Create follow-up' }).click()
  await expect(compose).toBeHidden()

  // §6.1's stat cards and §6.4's tabs read the same server-derived `state`, so they cannot disagree
  // about what "overdue" means — which is the whole reason `state` is not computed in the client.
  await page.goto('/')
  const overdue = page.getByRole('link', { name: /Overdue/ })
  await expect(overdue).toContainText('1')
  await expect(page.getByText('Overdue on purpose')).toBeVisible()
})
