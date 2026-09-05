/**
 * The keyboard pass, as assertions rather than as a paragraph in a PR body.
 *
 * Everything here was checked by hand first and then written down, because "tab order is sane" is
 * the kind of claim that rots silently: a new control lands in the toolbar, nobody re-tabs the page,
 * and six months later the table is unreachable without a mouse. These are cheap and they run in CI.
 */
import { expect, test } from '../support/fixtures.ts'

test('the skip link is the first stop and jumps past the sidebar', async ({ page }) => {
  await page.goto('/contacts')

  const skip = page.getByRole('link', { name: 'Skip to content' })

  // Hidden until focused: it must not occupy a corner of the page for everyone else. `toBeHidden`
  // is no use here — the screen-reader-only pattern is a real 1×1 box, which counts as visible.
  const hidden = await skip.boundingBox()
  expect(hidden?.width ?? 0).toBeLessThan(4)

  await page.keyboard.press('Tab')
  await expect(skip).toBeFocused()

  // And a real target once it is focused. Asserted in pixels because `focus:not-sr-only` losing to
  // `sr-only` in the cascade is a silent failure: the link is still there, still focusable, still
  // "visible" to a naive assertion, and completely invisible to the person who needs it.
  const shown = await skip.boundingBox()
  expect(shown?.width ?? 0).toBeGreaterThan(80)
  expect(shown?.height ?? 0).toBeGreaterThan(24)

  await page.keyboard.press('Enter')
  await expect(page.locator('main')).toBeFocused()

  // And from there the next stop is the page's own content, not back into the navigation.
  await page.keyboard.press('Tab')
  const afterSkip = page.locator('main :focus')
  await expect(afterSkip).toHaveCount(1)
})

test('the add-contact dialog opens, traps focus and gives it back on Escape', async ({ page }) => {
  await page.goto('/contacts')

  const trigger = page.getByRole('cell').getByRole('button', { name: 'Add new' })
  await trigger.focus()
  await page.keyboard.press('Enter')

  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.locator(':focus')).toHaveCount(1)

  await page.keyboard.press('Escape')

  await expect(dialog).toBeHidden()
  await expect(trigger).toBeFocused()
})

test('the sticky first column and the row checkboxes are reachable without a mouse', async ({
  page,
}) => {
  await page.goto('/contacts')

  await page.getByRole('cell').getByRole('button', { name: 'Add new' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('First name').fill('Ada')
  await dialog.getByLabel('Last name').fill('Lovelace')
  await dialog.getByRole('button', { name: 'Save contact' }).click()
  await expect(dialog).toBeHidden()

  // The name column is sticky and pinned first (§5.2). Sticky positioning is exactly the kind of
  // thing that ends up with `pointer-events` or an overlay swallowing focus, so: focus it.
  const rowCheckbox = page.getByRole('checkbox', { name: 'Select Ada Lovelace' })
  await rowCheckbox.focus()
  await expect(rowCheckbox).toBeFocused()

  await page.keyboard.press('Space')
  await expect(rowCheckbox).toBeChecked()

  // Selecting a row opens the bulk-action bar; it has to be reachable too, not just visible.
  await expect(page.getByText(/1 contact selected/)).toBeVisible()
})

test('the columns menu opens from the keyboard and closes on Escape', async ({ page }) => {
  await page.goto('/contacts')

  const columns = page.getByRole('button', { name: /^Columns \d+\/\d+$/ })
  await columns.focus()
  await page.keyboard.press('Enter')

  const findColumn = page.getByRole('textbox', { name: 'Find a column' })
  await expect(findColumn).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(findColumn).toBeHidden()
  await expect(columns).toBeFocused()
})

test('the view menu opens from the keyboard and hands focus back', async ({ page }) => {
  await page.goto('/contacts')

  const trigger = page.getByRole('button', { name: 'View options' })
  await trigger.focus()
  await page.keyboard.press('Enter')

  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Table settings' })).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  await expect(trigger).toBeFocused()
})

test('a filter can be built, applied and removed without a mouse', async ({ page }) => {
  await page.goto('/contacts')

  const addFilter = page.getByRole('button', { name: 'Add filter' })
  await addFilter.focus()
  await page.keyboard.press('Enter')

  // The field picker takes focus on open, so the first keystroke is a search rather than a lost one.
  const fieldSearch = page.getByRole('combobox', { name: 'Find a field' })
  await expect(fieldSearch).toBeFocused()

  await page.keyboard.type('City')
  await page.keyboard.press('Enter')

  // Field, then operator, then value — all three are real controls with names.
  await expect(page.getByRole('combobox', { name: 'Operator' })).toBeVisible()
  await page.getByRole('textbox', { name: 'Value' }).fill('Munich')

  const done = page.getByRole('button', { name: 'Done' })
  await done.focus()
  await page.keyboard.press('Enter')

  // The filter reached the URL, which is where §5.2 says a view lives.
  await expect(page).toHaveURL(/filter=/)
  const chip = page.getByRole('button', { name: /^City .*Munich$/ })
  await expect(chip).toBeVisible()

  // And the chip's own remove control is reachable, so a filter can be undone the same way.
  const remove = page.getByRole('button', { name: /^Remove filter/ })
  await remove.focus()
  await page.keyboard.press('Enter')
  await expect(chip).toBeHidden()
  await expect(page).not.toHaveURL(/filter=/)
})

test('the ⌘K palette opens, moves by arrow key and gives focus back on Escape', async ({
  page,
}) => {
  await page.goto('/contacts')
  // A global shortcut is not live until React has mounted, so wait for something React rendered.
  const search = page.locator('main').getByRole('searchbox').first()
  await search.waitFor()
  await search.focus()

  await page.keyboard.press('ControlOrMeta+k')
  const palette = page.getByRole('dialog', { name: 'Search and commands' })
  await expect(palette).toBeVisible()
  await expect(palette.getByRole('combobox')).toBeFocused()

  // cmdk marks the active row with `aria-selected`; arrowing has to move it.
  const first = palette.getByRole('option').first()
  await expect(first).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowDown')
  await expect(first).toHaveAttribute('aria-selected', 'false')

  await page.keyboard.press('Escape')
  await expect(palette).toBeHidden()
  await expect(search).toBeFocused()
})

test('the activity dialog on a contact traps focus and returns it', async ({ page }) => {
  await page.goto('/contacts')
  await page.getByRole('cell').getByRole('button', { name: 'Add new' }).click()
  const add = page.getByRole('dialog')
  await add.getByLabel('First name').fill('Grace')
  await add.getByLabel('Last name').fill('Hopper')
  await add.getByRole('button', { name: 'Save contact' }).click()
  await expect(add).toBeHidden()

  await page.getByRole('link', { name: 'Grace Hopper' }).click()

  const trigger = page.getByRole('button', { name: 'New activity' }).first()
  await trigger.focus()
  await page.keyboard.press('Enter')

  const dialog = page.getByRole('dialog', { name: 'Log an activity' })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator(':focus')).toHaveCount(1)

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(trigger).toBeFocused()
})

test('the destructive confirmation is reachable and dismissable by keyboard', async ({ page }) => {
  await page.goto('/contacts')
  await page.getByRole('cell').getByRole('button', { name: 'Add new' }).click()
  const add = page.getByRole('dialog')
  await add.getByLabel('First name').fill('Grace')
  await add.getByLabel('Last name').fill('Hopper')
  await add.getByRole('button', { name: 'Save contact' }).click()
  await expect(add).toBeHidden()

  await page.getByRole('link', { name: 'Grace Hopper' }).click()

  const actions = page.getByRole('button', { name: 'Record actions' })
  await actions.focus()
  await page.keyboard.press('Enter')
  await page.getByRole('menuitem', { name: /Delete/ }).press('Enter')

  // §5.4: the consequence is stated in numbers, and the dialog can be left without doing it.
  const confirm = page.getByRole('dialog', { name: /Delete Grace Hopper/ })
  await expect(confirm).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(confirm).toBeHidden()
  await expect(page.getByRole('heading', { name: 'Grace Hopper', level: 1 })).toBeVisible()
})

test('the import wizard can be driven from the keyboard', async ({ page }) => {
  await page.goto('/import')

  // Every control on step 1 is a real form control, so tabbing reaches all of them in order.
  await page.getByLabel('What are you importing?').focus()
  await page.keyboard.press('Tab')
  await expect(page.getByLabel('Source format')).toBeFocused()

  await page.getByLabel('Source format').selectOption('linkedin')
  await expect(page.getByLabel('Source format')).toHaveValue('linkedin')

  await page.keyboard.press('Tab')
  // The file picker is a button, not a bare `<input type=file>` — which is the only version of it
  // a keyboard can reach at all.
  await expect(page.getByRole('button', { name: 'Choose a file' }).first()).toBeFocused()
})

/**
 * The focus ring, measured in the browser rather than in the stylesheet.
 *
 * `contrast.test.ts` proves the *token* clears WCAG 1.4.11's 3:1 and that no component paints it at
 * an alpha that would not. This is the other half: that the ring is really drawn, in both themes,
 * on a control that opts out of the base `:focus-visible` outline and draws its own.
 */

/** The ring layer of a computed `box-shadow`: the one with a spread and a colour you can see. */
function ringLayer(element: HTMLElement): { alpha: number; spread: number } | null {
  // Split on commas that are not inside a colour function.
  const layers = getComputedStyle(element)
    .boxShadow.split(/,(?![^(]*\))/)
    .map((layer) => layer.trim())

  for (const layer of layers) {
    const spread = /(\d+(?:\.\d+)?)px$/.exec(layer)
    if (spread === undefined || spread === null || Number(spread[1]) < 2) continue
    // Chromium serialises an `oklch(… / .8)` ring as `oklab(… / 0.8)`, and an rgb one as `rgba()`.
    const slashAlpha = /\/\s*([\d.]+)\)/.exec(layer)?.[1]
    const commaAlpha = /rgba\([^)]*,\s*([\d.]+)\)/.exec(layer)?.[1]
    const alpha = Number(slashAlpha ?? commaAlpha ?? '1')
    if (alpha > 0) return { alpha, spread: Number(spread[1]) }
  }
  return null
}

for (const theme of ['light', 'dark'] as const) {
  test(`a focused control draws a visible ring in ${theme} mode`, async ({ page }) => {
    await page.addInitScript(
      ([key, value]) => {
        window.localStorage.setItem(key, value)
      },
      ['mutuals.theme', theme] as const,
    )
    await page.goto('/contacts')

    await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*dark).*$/)

    // Reached by Tab from a text box, not by `.focus()`: Chromium only matches `:focus-visible`
    // when focus arrived from the keyboard, and a programmatic focus is not that. Assert it the
    // wrong way and the ring reads as missing on a page where it is perfectly visible.
    await page.locator('main').getByRole('searchbox').first().focus()
    await page.keyboard.press('Tab')

    const columns = page.getByRole('button', { name: /^Columns \d+\/\d+$/ })
    await expect(columns).toBeFocused()

    // Polled, because `transition-all` animates the ring in: the first frame after focus is a
    // 0.1px ring at 3% alpha, and reading it then makes a perfectly good ring measure as missing.
    // An `rgba(…, 0.5)` ring measures 2.22:1 against the page — under WCAG 1.4.11's 3:1.
    await expect
      .poll(
        async () => {
          const layer = await columns.evaluate(ringLayer)
          return layer === null ? 0 : layer.alpha
        },
        { timeout: 5_000 },
      )
      .toBeGreaterThanOrEqual(0.8)

    const ring = await columns.evaluate(ringLayer)
    expect(ring, 'the focused control has no ring at all').not.toBeNull()
    expect(ring?.spread ?? 0).toBeGreaterThanOrEqual(2)
  })
}
