import type { AttributeDefinitionDto } from '@mutuals/core'
import { describe, expect, it } from 'vitest'

import {
  addOption,
  configOf,
  createBody,
  draftFromDefinition,
  emptyDraft,
  moveOption,
  optionKey,
  optionWrites,
  removeOption,
  setOptionColor,
  setOptionLabel,
  setSlug,
  setTitle,
  setType,
  updateBody,
  type AttributeDraft,
} from './draft.ts'

const TAKEN = new Set(['city', 'country'])

function labelled(draft: AttributeDraft, labels: readonly string[]): AttributeDraft {
  return labels.reduce((current, label, index) => {
    const withRow = current.options.length > index ? current : addOption(current)
    const row = withRow.options[index]
    if (row === undefined) throw new Error('missing row')
    return setOptionLabel(withRow, row.rowId, label)
  }, draft)
}

function definition(overrides: Partial<AttributeDefinitionDto> = {}): AttributeDefinitionDto {
  return {
    id: 'a1',
    objectType: 'contact',
    title: 'Job role',
    slug: 'job_role',
    type: 'single_select',
    config: {},
    options: [],
    group: 'Work',
    description: 'What they do',
    isSystem: false,
    isMulti: false,
    isDerived: false,
    sortable: true,
    position: 3,
    showByDefault: true,
    recordCount: 12,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('the slug follows the title', () => {
  it('suggests one from the title while the slug is untouched', () => {
    const draft = setTitle(emptyDraft('contact'), 'Ticket size', TAKEN)
    expect(draft.slug).toBe('ticket_size')
  })

  it('transliterates the way a person would have typed it', () => {
    expect(setTitle(emptyDraft('contact'), 'Größe', TAKEN).slug).toBe('groesse')
  })

  it('avoids a slug that is already taken', () => {
    expect(setTitle(emptyDraft('contact'), 'City', TAKEN).slug).toBe('city_2')
  })

  it('stops suggesting once the slug is edited by hand', () => {
    const edited = setSlug(
      setTitle(emptyDraft('contact'), 'Ticket size', TAKEN),
      'deal_size',
      TAKEN,
    )
    const renamed = setTitle(edited, 'Cheque size', TAKEN)
    expect(renamed.slug).toBe('deal_size')
  })

  it('resumes suggesting when the slug field is emptied', () => {
    const edited = setSlug(setTitle(emptyDraft('contact'), 'Ticket size', TAKEN), 'x', TAKEN)
    const cleared = setSlug(edited, '', TAKEN)
    expect(cleared.slugEdited).toBe(false)
    expect(cleared.slug).toBe('ticket_size')
  })

  it('leaves the slug empty while the title is', () => {
    expect(setTitle(emptyDraft('contact'), '   ', TAKEN).slug).toBe('')
  })
})

describe('option keys', () => {
  it('derives a machine key from the label', () => {
    expect(optionKey('Community builder', [])).toBe('community_builder')
  })

  it('falls back rather than producing an empty key', () => {
    expect(optionKey('!!!', [])).toBe('option')
  })

  it('suffixes a key that is already used', () => {
    expect(optionKey('Investor', ['investor'])).toBe('investor_2')
  })

  it('follows the label while the option is unsaved', () => {
    const draft = labelled(setType(emptyDraft('contact'), 'single_select'), ['Investor'])
    expect(draft.options[0]?.key).toBe('investor')
    const renamed = setOptionLabel(draft, draft.options[0]?.rowId ?? '', 'Angel')
    expect(renamed.options[0]?.key).toBe('angel')
  })

  it('never rewrites the key of a saved option, because saved views are written against it', () => {
    const draft = draftFromDefinition(
      definition({
        options: [
          {
            id: 'o1',
            key: 'investor',
            label: 'Investor',
            color: 'blue',
            position: 0,
            archivedAt: null,
          },
        ],
      }),
    )
    const renamed = setOptionLabel(draft, 'o1', 'Angel')
    expect(renamed.options[0]).toMatchObject({ key: 'investor', label: 'Angel' })
  })

  it('does not reuse the key of an option that was archived', () => {
    const draft = draftFromDefinition(
      definition({
        options: [
          {
            id: 'o1',
            key: 'angel',
            label: 'Angel',
            color: 'blue',
            position: 0,
            archivedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    )
    const added = labelled(draft, ['Angel'])
    expect(added.options[0]?.key).toBe('angel_2')
  })
})

describe('the options list', () => {
  it('opens with one row when the type becomes a select', () => {
    expect(setType(emptyDraft('contact'), 'multi_select').options).toHaveLength(1)
  })

  it('gives each new option a colour that is not already in the list', () => {
    const two = addOption(setType(emptyDraft('contact'), 'single_select'))
    expect(two.options[0]?.color).not.toBe(two.options[1]?.color)
  })

  it('reorders, because for a single select this order is the sort order', () => {
    const draft = labelled(setType(emptyDraft('contact'), 'single_select'), ['A', 'B', 'C'])
    const moved = moveOption(draft, 2, 0)
    expect(moved.options.map((option) => option.label)).toEqual(['C', 'A', 'B'])
  })

  it('ignores a move that runs off either end', () => {
    const draft = labelled(setType(emptyDraft('contact'), 'single_select'), ['A', 'B'])
    expect(moveOption(draft, 0, -1)).toBe(draft)
    expect(moveOption(draft, 1, 2)).toBe(draft)
  })

  it('removes an unsaved row', () => {
    const draft = labelled(setType(emptyDraft('contact'), 'single_select'), ['A', 'B'])
    const rowId = draft.options[0]?.rowId ?? ''
    expect(removeOption(draft, rowId).options.map((option) => option.label)).toEqual(['B'])
  })

  it('recolours one row and leaves the others alone', () => {
    const draft = labelled(setType(emptyDraft('contact'), 'single_select'), ['A', 'B'])
    const recoloured = setOptionColor(draft, draft.options[1]?.rowId ?? '', 'pink')
    expect(recoloured.options[1]?.color).toBe('pink')
    expect(recoloured.options[0]?.color).toBe(draft.options[0]?.color)
  })
})

describe('draftFromDefinition', () => {
  it('splits live options from archived ones and sorts by position', () => {
    const draft = draftFromDefinition(
      definition({
        options: [
          { id: 'o2', key: 'b', label: 'B', color: 'red', position: 1, archivedAt: null },
          { id: 'o1', key: 'a', label: 'A', color: 'blue', position: 0, archivedAt: null },
          {
            id: 'o3',
            key: 'c',
            label: 'C',
            color: null,
            position: 2,
            archivedAt: '2026-02-01T00:00:00.000Z',
          },
        ],
      }),
    )
    expect(draft.options.map((option) => option.key)).toEqual(['a', 'b'])
    expect(draft.archived.map((option) => option.key)).toEqual(['c'])
  })

  it('falls back to grey for a colour that is not one of the eleven', () => {
    const draft = draftFromDefinition(
      definition({
        options: [
          { id: 'o1', key: 'a', label: 'A', color: '#ff0000', position: 0, archivedAt: null },
        ],
      }),
    )
    expect(draft.options[0]?.color).toBe('gray')
  })

  it('reads a number config back into the form', () => {
    const draft = draftFromDefinition(
      definition({ type: 'number', config: { unit: 'EUR', decimals: 2 }, options: [] }),
    )
    expect(draft.number).toEqual({ unit: 'EUR', decimals: '2' })
  })

  it('reads a relation config written in either casing', () => {
    const draft = draftFromDefinition(
      definition({
        type: 'relation',
        config: { target_object_type: 'organization', cardinality: 'many' },
        options: [],
      }),
    )
    expect(draft.relation).toEqual({ targetObjectType: 'organization', cardinality: 'many' })
  })
})

describe('the request bodies', () => {
  it('sends no config for a type that has none', () => {
    const draft = setTitle(emptyDraft('contact'), 'City', new Set())
    expect(createBody(draft)).not.toHaveProperty('config')
  })

  it('omits an empty unit and an empty decimals on create', () => {
    const draft = setType(emptyDraft('contact'), 'number')
    expect(configOf(draft)).toEqual({})
  })

  it('turns a blank group and description into null', () => {
    const body = createBody(setTitle(emptyDraft('contact'), 'City', new Set()))
    expect(body['group']).toBeNull()
    expect(body['description']).toBeNull()
  })

  it('sends the unit as an empty string on edit, because PATCH merges config', () => {
    const draft = draftFromDefinition(
      definition({ type: 'number', config: { unit: 'EUR' }, options: [] }),
    )
    const cleared = { ...draft, number: { ...draft.number, unit: '' } }
    expect(updateBody(cleared)['config']).toEqual({ unit: '' })
  })

  it('never sends slug or type on edit', () => {
    const body = updateBody(draftFromDefinition(definition()))
    expect(body).not.toHaveProperty('slug')
    expect(body).not.toHaveProperty('type')
  })

  it('never sends a relation config on edit, because is_multi is not recomputed', () => {
    const draft = draftFromDefinition(
      definition({
        type: 'relation',
        config: { targetObjectType: 'contact', cardinality: 'one' },
        options: [],
      }),
    )
    expect(updateBody(draft)).not.toHaveProperty('config')
  })
})

describe('optionWrites', () => {
  const saved = draftFromDefinition(
    definition({
      options: [
        { id: 'o1', key: 'a', label: 'A', color: 'blue', position: 0, archivedAt: null },
        { id: 'o2', key: 'b', label: 'B', color: 'red', position: 1, archivedAt: null },
        { id: 'o3', key: 'c', label: 'C', color: 'green', position: 2, archivedAt: null },
      ],
    }),
  )

  it('writes final positions only when nothing moved', () => {
    const writes = optionWrites(saved)
    expect(writes).toHaveLength(3)
    expect(writes.map((write) => write['position'])).toEqual([0, 1, 2])
  })

  it('parks every saved row above the maximum before writing a reorder', () => {
    // The update route applies one option at a time against a UNIQUE (attribute_id, position),
    // so a straight swap answers 409 — verified against the running API.
    const writes = optionWrites(moveOption(saved, 2, 0))
    expect(writes).toHaveLength(6)
    const positions = writes.map((write) => write['position'] as number)
    expect(Math.min(...positions.slice(0, 3))).toBeGreaterThan(2)
    expect(positions.slice(3)).toEqual([0, 1, 2])
    expect(writes.slice(3).map((write) => write['id'])).toEqual(['o3', 'o1', 'o2'])
  })

  it('never parks a row that has no id, because a new option cannot collide', () => {
    const withNew = addOption(moveOption(saved, 2, 0))
    const writes = optionWrites(withNew)
    expect(writes.filter((write) => write['id'] === undefined)).toHaveLength(1)
  })

  it('keeps archived options behind the live ones so the picker order is the position order', () => {
    const draft = draftFromDefinition(
      definition({
        options: [
          {
            id: 'o1',
            key: 'a',
            label: 'A',
            color: 'blue',
            position: 0,
            archivedAt: '2026-02-01T00:00:00.000Z',
          },
          { id: 'o2', key: 'b', label: 'B', color: 'red', position: 1, archivedAt: null },
        ],
      }),
    )
    const writes = optionWrites(draft)
    const finals = writes.slice(writes.length - 2)
    expect(finals.map((write) => [write['id'], write['position']])).toEqual([
      ['o2', 0],
      ['o1', 1],
    ])
  })
})
