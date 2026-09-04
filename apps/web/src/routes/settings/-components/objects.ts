/**
 * The objects Settings can describe (§6.6: "Objects → Contacts, Organizations. Nothing else in
 * Phase 1.").
 *
 * Data rather than two hand-written links, because the nav renders the list while each object's
 * four route files name one entry — and a third object should be one line here plus its routes,
 * not an edit in three components.
 *
 * `interaction` is deliberately absent. It is a real `ObjectType` with attributes of its own, but
 * §6.4 owns it and it has no list page to configure yet.
 */
import type { ObjectType } from '@mutuals/core'

export interface SettingsObject {
  readonly objectType: ObjectType
  /** Plural, as the nav and the breadcrumb say it. */
  readonly label: string
  /** Singular and lower case, for a sentence: "the fields on a contact". */
  readonly noun: string
  /** Carried beside the noun rather than derived: "an organization", "a contact". */
  readonly article: string
  /** Where this object is configured. */
  readonly to: string
  /** Where its records are listed — the table these settings describe. */
  readonly table: string
}

export const CONTACTS_OBJECT = {
  objectType: 'contact',
  label: 'Contacts',
  noun: 'contact',
  article: 'a',
  to: '/settings/contacts',
  table: '/contacts',
} as const satisfies SettingsObject

export const ORGANIZATIONS_OBJECT = {
  objectType: 'organization',
  label: 'Organizations',
  noun: 'organization',
  article: 'an',
  to: '/settings/organizations',
  table: '/organizations',
} as const satisfies SettingsObject

export const SETTINGS_OBJECTS: readonly SettingsObject[] = [CONTACTS_OBJECT, ORGANIZATIONS_OBJECT]
