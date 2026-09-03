/**
 * Fixtures that go through the real write path (ADR-076).
 *
 * Every builder here is an HTTP call, so a fixture is itself a test of the operation that created
 * it. Raw `INSERT`s would let a test pass while the projector is broken — which is the strongest
 * argument in this area and the reason none appear below.
 */
import type { Contact, FollowUp, Interaction, Organization } from '@mutuals/core'
import { expect } from 'vitest'

import { api } from './app.ts'

function created<T>(status: number, body: T, what: string): T {
  expect(status, `creating ${what} returned ${String(status)}: ${JSON.stringify(body)}`).toBe(201)
  return body
}

export async function aContact(
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<Contact> {
  const { status, body } = await api.post<Contact>('/api/v1/contacts', {
    firstName: 'Anna',
    lastName: 'Berger',
    ...overrides,
  })
  return created(status, body, 'a contact')
}

export async function anOrganization(
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<Organization> {
  const { status, body } = await api.post<Organization>('/api/v1/organizations', {
    name: 'Northstar Ventures',
    ...overrides,
  })
  return created(status, body, 'an organization')
}

export async function anInteraction(
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<Interaction> {
  const { status, body } = await api.post<Interaction>('/api/v1/interactions', {
    type: 'Meeting',
    occurredAt: '2026-06-01T10:00:00.000Z',
    title: 'Coffee',
    ...overrides,
  })
  return created(status, body, 'an interaction')
}

export async function aFollowUp(
  contactId: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Promise<FollowUp> {
  const { status, body } = await api.post<FollowUp>('/api/v1/follow-ups', {
    title: 'Send the deck',
    contactId,
    dueAt: '2026-06-20',
    ...overrides,
  })
  return created(status, body, 'a follow-up')
}

export interface CreatedAttribute {
  readonly id: string
  readonly slug: string
}

export async function anAttribute(
  body: Readonly<Record<string, unknown>>,
): Promise<CreatedAttribute> {
  const result = await api.post<CreatedAttribute>('/api/v1/attribute-definitions', body)
  return created(result.status, result.body, `attribute ${String(body['slug'])}`)
}
