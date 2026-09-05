/**
 * §5.2's "empty state with a call to action", checked everywhere it can appear.
 *
 * Every spec here starts from the state the very first person to open Mutuals is in: a migrated
 * database with no contacts, no organizations, no interactions and no follow-ups. That state is
 * invisible on a seeded machine, which is exactly why it rots — the screens nobody ever sees are
 * the ones that greet a new user, and the seed hides all of them at once.
 *
 * The bar is the one the brief sets and the stage repeats: an empty state must say **what the
 * thing is** and offer **the action that fills it**. A bare "No results" fails, and so does a
 * heading with nothing under it.
 */
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

test('the dashboard greets a workspace that has nothing in it', async ({ page }) => {
  await page.goto('/')

  // The seeded profile has no first name, and `Good evening, ` — a comma addressed to nobody — is
  // what interpolating an empty string used to produce. The greeting owns the comma or drops it.
  const greeting = page.getByRole('heading', { level: 1 })
  await expect(greeting).toHaveText(/^Good (morning|afternoon|evening)$/)

  // Both lists say what they are for, and both offer the way in.
  await expect(page.getByRole('heading', { name: 'Nothing needs you this week' })).toBeVisible()
  await expect(page.getByText(/Overdue follow-ups and anything due/)).toBeVisible()

  await expect(page.getByRole('heading', { name: 'Nobody here yet' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Add your first contact' })).toBeVisible()
})

test('an empty table names its object and offers both ways to fill it', async ({ page }) => {
  await page.goto('/contacts')

  const contacts = page.getByRole('row', { name: /No contacts yet/ })
  await expect(contacts).toBeVisible()
  await expect(contacts).toContainText('Create the first contact')
  await expect(contacts.getByRole('button', { name: 'Add new' })).toBeVisible()
  await expect(contacts.getByRole('button', { name: 'More ways to add' })).toBeVisible()

  await page.goto('/organizations')
  const organizations = page.getByRole('row', { name: /No organizations yet/ })
  await expect(organizations).toBeVisible()
  await expect(organizations).toContainText('Create the first organization')
})

test('a search that matches nothing blames the search, and a filter blames the filter', async ({
  page,
}) => {
  await addContact(page, 'Ada', 'Lovelace')

  // A search, and no filters at all. "Loosen a filter" would send the reader looking for one.
  await page.goto('/contacts?q=zzzznothing')
  const searched = page.getByRole('row', { name: /No contact matches/ })
  await expect(searched).toContainText('No contact matches “zzzznothing”')
  await expect(searched).toContainText('The search runs over the text columns on screen')
  await expect(searched.getByRole('button', { name: 'Clear the search' })).toBeVisible()

  // One filter, no search: a different sentence, and one that explains why AND is the problem.
  await page.getByRole('button', { name: 'Clear the search' }).click()
  await page.getByRole('button', { name: 'Add filter' }).click()
  await page.getByRole('combobox', { name: 'Find a field' }).fill('City')
  await page.getByRole('option', { name: 'City', exact: true }).click()
  await page.getByRole('textbox', { name: 'Value' }).fill('Atlantis')
  await page.getByRole('button', { name: 'Done' }).click()

  const filtered = page.getByRole('row', { name: /No contact matches/ })
  await expect(filtered).toContainText('Nothing satisfies all 1 filter')
  await expect(filtered).toContainText('Filters combine with AND')
  await expect(filtered.getByRole('button', { name: 'Clear filters and search' })).toBeVisible()

  // And the way out works: one click restores the table.
  await filtered.getByRole('button', { name: 'Clear filters and search' }).click()
  await expect(page.getByRole('link', { name: 'Ada Lovelace' })).toBeVisible()
})

test('a contact with nothing on it explains every tab it has', async ({ page }) => {
  await addContact(page, 'Ada', 'Lovelace')
  await page.getByRole('link', { name: 'Ada Lovelace' }).click()

  await expect(page.getByRole('heading', { name: 'Nothing logged yet' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'New activity' })).toBeVisible()

  await page.getByRole('tab', { name: 'Connections' }).click()
  const connections = page.getByRole('tabpanel', { name: 'Connections' })
  await expect(connections.getByRole('heading', { name: 'No connections yet' })).toBeVisible()
  await expect(connections).toContainText('Link this contact to an organization')

  await page.getByRole('tab', { name: 'Follow-ups' }).click()
  const followUps = page.getByRole('tabpanel', { name: 'Follow-ups' })
  await expect(followUps.getByRole('heading', { name: 'Nothing to follow up on' })).toBeVisible()
  await expect(followUps.getByRole('button', { name: 'Add follow-up' }).first()).toBeVisible()
})

test('an organization with nobody in it says so on a tab of its own', async ({ page }) => {
  await page.goto('/organizations')
  await page.getByRole('button', { name: 'Add new' }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Name').fill('Analytical Engines Ltd')
  await dialog.getByRole('button', { name: /Save/ }).click()
  await expect(dialog).toBeHidden()

  await page.getByRole('link', { name: 'Analytical Engines Ltd' }).click()

  // The roster is a tab, not a link into the contacts table — because "0 people" landing on
  // "no records satisfy every active filter" describes a query, not a company.
  await page.getByRole('tab', { name: 'People' }).click()
  const people = page.getByRole('tabpanel', { name: 'People' })
  await expect(people.getByRole('heading', { name: 'Nobody works here yet' })).toBeVisible()
  await expect(people).toContainText('set their organization to this one')
  await expect(people.getByRole('link', { name: 'Go to Contacts' })).toBeVisible()
})

test('the follow-ups page says what a follow-up is before there is one', async ({ page }) => {
  await page.goto('/follow-ups')

  const open = page.getByRole('tabpanel', { name: 'Open' })
  await expect(open.getByRole('heading', { name: 'Nothing to follow up on' })).toBeVisible()
  await expect(open).toContainText('send the deck, make the intro, check in after the round')
  await expect(open.getByRole('button', { name: 'Create follow-up' })).toBeVisible()
})

test('a workspace with no saved views explains what a view is', async ({ page }) => {
  await page.goto('/settings/contacts/views')

  await expect(page.getByRole('heading', { name: 'No saved views yet' })).toBeVisible()
  await expect(page.getByText(/Save as new view/)).toBeVisible()
  await expect(page.getByRole('link', { name: 'Open the Contacts table' })).toBeVisible()
})

test('the palette says what it searched when it finds nothing', async ({ page }) => {
  await page.goto('/contacts')
  // A global shortcut is not live until React has mounted (see docs/HANDOFF.md).
  await page.getByRole('searchbox', { name: 'Search' }).first().waitFor()

  await page.keyboard.press('ControlOrMeta+k')
  const palette = page.getByRole('dialog', { name: 'Search and commands' })
  await expect(palette).toBeVisible()

  await page.keyboard.type('zzzznothing')
  await expect(palette.getByText('Nothing matches “zzzznothing”.')).toBeVisible()
  await expect(palette.getByText(/Names, email addresses, links/)).toBeVisible()

  // And no heading left standing over an empty list: the actions are filtered by the same needle,
  // so with none of them matching the group goes too.
  await expect(palette.getByText('Actions')).toBeHidden()
})

test('the profile shows a placeholder rather than a blank line', async ({ page }) => {
  await page.goto('/settings/profile')

  // The seeded profile's names are empty strings, and an empty string renders as nothing at all —
  // a row with a label and a void beside it, which reads as a page that failed to load.
  const firstName = page.getByRole('term').filter({ hasText: 'First name' })
  await expect(firstName).toBeVisible()
  const values = page.getByRole('definition')
  for (const value of await values.all()) {
    await expect(value).not.toHaveText('')
  }
})
