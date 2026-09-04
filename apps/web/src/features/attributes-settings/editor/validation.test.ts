import { describe, expect, it } from 'vitest'

import {
  addOption,
  emptyDraft,
  setOptionLabel,
  setTitle,
  setType,
  type AttributeDraft,
} from './draft.ts'
import {
  OPTIONS_REQUIRED,
  TITLE_REQUIRED,
  isValid,
  mergeIssues,
  validateDraft,
  type ValidationContext,
} from './validation.ts'

const CREATE: ValidationContext = {
  mode: 'create',
  takenSlugs: new Set(['city']),
  objectType: 'contact',
}

function named(title: string): AttributeDraft {
  return setTitle(emptyDraft('contact'), title, CREATE.takenSlugs)
}

function withLabels(draft: AttributeDraft, labels: readonly string[]): AttributeDraft {
  return labels.reduce((current, label, index) => {
    const withRow = current.options.length > index ? current : addOption(current)
    const row = withRow.options[index]
    if (row === undefined) throw new Error('missing row')
    return setOptionLabel(withRow, row.rowId, label)
  }, draft)
}

describe('title', () => {
  it('is required, in the reference screenshot’s exact words', () => {
    expect(validateDraft(emptyDraft('contact'), CREATE).get('title')).toBe(TITLE_REQUIRED)
  })

  it('accepts a title that is only whitespace as empty', () => {
    expect(validateDraft(named('   '), CREATE).get('title')).toBe(TITLE_REQUIRED)
  })

  it('refuses a title over the API’s limit before the round trip', () => {
    expect(validateDraft(named('x'.repeat(121)), CREATE).get('title')).toMatch(/at most 120/)
  })

  it('passes a normal title', () => {
    expect(validateDraft(named('Ticket size'), CREATE).has('title')).toBe(false)
  })
})

describe('slug', () => {
  it('says which rule was broken, never just “invalid”', () => {
    const draft = { ...named('Ticket size'), slug: 'Ticket Size', slugEdited: true }
    expect(validateDraft(draft, CREATE).get('slug')).toMatch(/lower-case letters, digits/)
  })

  it('names a reserved slug as reserved, and suggests a way out', () => {
    const draft = { ...named('First name'), slug: 'first_name', slugEdited: true }
    const message = validateDraft(draft, CREATE).get('slug')
    expect(message).toMatch(/reserved/)
    expect(message).toMatch(/first_name_1/)
  })

  it('names a duplicate slug as taken', () => {
    const draft = { ...named('City'), slug: 'city', slugEdited: true }
    expect(validateDraft(draft, CREATE).get('slug')).toMatch(/already used/)
  })

  it('says a slug is required when it is empty', () => {
    const draft = { ...named('Ticket size'), slug: '', slugEdited: true }
    expect(validateDraft(draft, CREATE).get('slug')).toMatch(/required/)
  })

  it('is not validated on edit, because the field is locked', () => {
    const draft = { ...named('City'), slug: 'city', slugEdited: true }
    const issues = validateDraft(draft, { ...CREATE, mode: 'edit' })
    expect(issues.has('slug')).toBe(false)
  })
})

describe('select options (ADR-038)', () => {
  it('refuses a select with no options, in the same style as “Title is required”', () => {
    const draft = { ...setType(named('Stage'), 'single_select'), options: [] }
    expect(validateDraft(draft, CREATE).get('options')).toBe(OPTIONS_REQUIRED)
  })

  it('requires a label on every row', () => {
    const draft = setType(named('Stage'), 'single_select')
    expect(validateDraft(draft, CREATE).get('options.0.label')).toMatch(/required/)
  })

  it('catches two options with the same label before the API does', () => {
    const draft = withLabels(setType(named('Stage'), 'single_select'), ['Investor', 'investor'])
    expect(validateDraft(draft, CREATE).get('options.1.label')).toMatch(/already an option/)
    expect(validateDraft(draft, CREATE).has('options.0.label')).toBe(false)
  })

  it('leaves a valid list alone', () => {
    const draft = withLabels(setType(named('Stage'), 'single_select'), ['Investor', 'Operator'])
    expect(isValid(validateDraft(draft, CREATE))).toBe(true)
  })

  it('asks nothing of a tags attribute, which has no option list at all', () => {
    const draft = setType(named('Interests'), 'tags')
    expect(validateDraft(draft, CREATE).has('options')).toBe(false)
  })
})

describe('number config', () => {
  function numeric(unit: string, decimals: string): AttributeDraft {
    const base = setType(named('Ticket size'), 'number')
    return { ...base, number: { unit, decimals } }
  }

  it('accepts an empty decimals as “exactly as entered”', () => {
    expect(validateDraft(numeric('EUR', ''), CREATE).has('config.decimals')).toBe(false)
  })

  it('refuses a decimals that is not a whole number in range', () => {
    expect(validateDraft(numeric('', '2.5'), CREATE).get('config.decimals')).toMatch(/whole number/)
    expect(validateDraft(numeric('', '11'), CREATE).get('config.decimals')).toMatch(/whole number/)
    expect(validateDraft(numeric('', '-1'), CREATE).get('config.decimals')).toMatch(/whole number/)
  })

  it('refuses a unit longer than the API accepts', () => {
    expect(validateDraft(numeric('x'.repeat(17), ''), CREATE).get('config.unit')).toMatch(/16/)
  })

  it('says plainly that a saved decimals cannot be cleared, rather than dropping the change', () => {
    const issues = validateDraft(numeric('EUR', ''), {
      ...CREATE,
      mode: 'edit',
      savedDecimals: 2,
    })
    expect(issues.get('config.decimals')).toMatch(/cannot be cleared/)
  })
})

describe('merging with the API’s answer', () => {
  it('lets the server have the last word on a field', () => {
    const local = new Map([['slug', 'local']])
    const remote = new Map([['slug', 'remote']])
    expect(mergeIssues(local, remote).get('slug')).toBe('remote')
  })

  it('returns the local map untouched when nothing came back', () => {
    const local = new Map([['title', TITLE_REQUIRED]])
    expect(mergeIssues(local, new Map())).toBe(local)
  })
})
