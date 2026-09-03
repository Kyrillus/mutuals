import { describe, expect, it } from 'vitest'

import { OBJECT_TYPES, VALUE_KINDS } from '../attributes/kinds.ts'
import { isOperatorId } from '../attributes/operators.ts'
import {
  RELATIONSHIP_GROUP,
  SYSTEM_FIELDS,
  allSystemSlugs,
  fieldGroup,
  isMetricTable,
  systemField,
  systemFields,
} from './system.ts'

describe('the system field registry', () => {
  it('covers every object type', () => {
    expect(Object.keys(SYSTEM_FIELDS).sort()).toEqual([...OBJECT_TYPES].sort())
  })

  it('has unique slugs within an object type', () => {
    for (const objectType of OBJECT_TYPES) {
      const slugs = allSystemSlugs(objectType)
      expect(new Set(slugs).size, objectType).toBe(slugs.length)
    }
  })

  it('uses only declared value kinds and declared operators', () => {
    for (const objectType of OBJECT_TYPES) {
      for (const field of systemFields(objectType)) {
        expect(VALUE_KINDS, field.slug).toContain(field.valueKind)
        for (const operator of field.operators) {
          expect(isOperatorId(operator), `${field.slug}.${operator}`).toBe(true)
        }
      }
    }
  })

  it('declares every derived column §4.7 and §5.2 name, and marks them read-only', () => {
    const contactDerived = systemFields('contact')
      .filter((field) => field.derived)
      .map((field) => field.slug)
    expect([...contactDerived].sort()).toEqual([
      'interaction_count_12m',
      'last_interaction_at',
      'next_followup_at',
      'open_followups',
      'warmth',
    ])
    expect(
      systemFields('organization')
        .filter((f) => f.derived)
        .map((f) => f.slug),
    ).toContain('people_count')
    for (const objectType of OBJECT_TYPES) {
      for (const field of systemFields(objectType)) {
        if (field.derived) expect(field.readOnly, field.slug).toBe(true)
      }
    }
  })

  it('puts every derived column in a metric table and nothing else', () => {
    for (const objectType of OBJECT_TYPES) {
      for (const field of systemFields(objectType)) {
        expect(isMetricTable(field.table), field.slug).toBe(field.derived)
      }
    }
    expect(isMetricTable('contact')).toBe(false)
  })

  it('groups the relationship columns so the detail sidebar has a section for them', () => {
    expect(fieldGroup(systemField('contact', 'warmth')!)).toBe(RELATIONSHIP_GROUP)
    expect(fieldGroup(systemField('contact', 'display_name')!)).toBeUndefined()
  })

  it('finds a field by slug and reports an unknown one', () => {
    expect(systemField('contact', 'display_name')?.label).toBe('Name')
    expect(systemField('contact', 'people_count')).toBeUndefined()
    expect(systemField('organization', 'people_count')?.label).toBe('People')
  })

  it('shows the columns §6.2 and §6.3 put in the default view', () => {
    const contactDefaults = systemFields('contact')
      .filter((field) => field.showByDefault)
      .map((field) => field.slug)
    expect(contactDefaults).toEqual(['display_name', 'created_at', 'last_interaction_at'])

    const organizationDefaults = systemFields('organization')
      .filter((field) => field.showByDefault)
      .map((field) => field.slug)
    expect(organizationDefaults).toEqual(['name', 'created_at', 'people_count'])
  })

  it('collides with none of the attribute slugs the brief seeds', () => {
    const seeded = {
      contact: [
        'email',
        'phone',
        'job_role',
        'organization',
        'city',
        'country',
        'birthday',
        'areas_of_interest',
        'asks',
        'offers',
        'linkedin_url',
        'website',
        'how_we_met',
        'notes',
      ],
      organization: [
        'type',
        'industry',
        'city',
        'country',
        'website',
        'linkedin_url',
        'description',
        'stage',
      ],
    } as const

    for (const [objectType, slugs] of Object.entries(seeded)) {
      const system = new Set(allSystemSlugs(objectType as 'contact' | 'organization'))
      for (const slug of slugs) expect(system.has(slug), `${objectType}.${slug}`).toBe(false)
    }
  })
})
