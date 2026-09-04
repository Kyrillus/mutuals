/**
 * How the twelve attribute types are *presented* — an icon, a name a person would say out loud,
 * and one line explaining when to reach for this one rather than the one above it.
 *
 * The membership and the order of the picker come from `ATTRIBUTE_TYPES`, so this file cannot
 * decide that a type exists. What it adds is the prose the registry deliberately does not carry:
 * `packages/core` ships to the browser and knows nothing about React or about English copy, and a
 * `description` field on `AttributeTypeDefinition` would put UI text inside the domain.
 *
 * The table is keyed by `AttributeType`, which is derived from the registry — so a thirteenth type
 * is a compile error here rather than a type that quietly renders without a name.
 */
import { ATTRIBUTE_TYPES, type AttributeType } from '@mutuals/core'
import {
  AtSign,
  Calendar,
  CircleDot,
  Hash,
  Link,
  ListChecks,
  Phone,
  Tags,
  TextAlignStart,
  ToggleLeft,
  Type,
  Waypoints,
  type LucideIcon,
} from 'lucide-react'

export interface AttributeTypeMeta {
  readonly label: string
  /** One line, and it must say what makes this type different from its neighbour. */
  readonly description: string
  readonly icon: LucideIcon
}

const META: Record<AttributeType, AttributeTypeMeta> = {
  short_text: {
    label: 'Short text',
    description: 'One line, shown in full in the table. A city, a nickname, a job title.',
    icon: Type,
  },
  long_text: {
    label: 'Long text',
    description: 'Several lines, truncated in the table. Notes, a story, how you met.',
    icon: TextAlignStart,
  },
  number: {
    label: 'Number',
    description: 'A figure you can sort and compare, with an optional unit like € or years.',
    icon: Hash,
  },
  date: {
    label: 'Date',
    description: 'A day, without a time. Birthdays, joined-on, a deadline.',
    icon: Calendar,
  },
  yes_no: {
    label: 'Yes / No',
    description: 'A checkbox with three states: yes, no, and not answered yet.',
    icon: ToggleLeft,
  },
  single_select: {
    label: 'Single select',
    description: 'One choice from a list you define. Sorts in the order you put the options in.',
    icon: CircleDot,
  },
  multi_select: {
    label: 'Multi select',
    description: 'Several choices from the same fixed list.',
    icon: ListChecks,
  },
  tags: {
    label: 'Tags',
    description: 'Free-form labels anyone can invent while typing — no list to maintain.',
    icon: Tags,
  },
  url: {
    label: 'Link',
    description: 'A web address, shown as a clickable link.',
    icon: Link,
  },
  email: {
    label: 'Email',
    description: 'An email address, checked for shape and used to spot duplicates.',
    icon: AtSign,
  },
  phone: {
    label: 'Phone',
    description: 'A phone number, normalised to its international form.',
    icon: Phone,
  },
  relation: {
    label: 'Relation',
    description: 'A link to another record — a person, an organization — not a copy of its name.',
    icon: Waypoints,
  },
}

export function typeMeta(type: AttributeType): AttributeTypeMeta {
  return META[type]
}

/** The picker's list, in registry order, so the order is decided in one place for the whole app. */
export const ATTRIBUTE_TYPE_CHOICES: readonly {
  readonly type: AttributeType
  readonly meta: AttributeTypeMeta
}[] = ATTRIBUTE_TYPES.map((type) => ({ type, meta: META[type] }))

/**
 * The label for a type that may not be one — the wire types `type` as `string`, because
 * `AttributeTypeSchema` casts its enum to `[string, ...string[]]` and erases the union.
 */
export function typeLabel(type: string): string {
  return isKnown(type) ? META[type].label : type
}

export function typeIcon(type: string): LucideIcon | undefined {
  return isKnown(type) ? META[type].icon : undefined
}

function isKnown(type: string): type is AttributeType {
  return type in META
}
