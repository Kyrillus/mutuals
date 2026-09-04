/**
 * The attribute editor — §6.7's create and edit dialog, and the presentation of the twelve types
 * that the attributes list shares with it.
 */
export { AttributeDialog, SLUG_HELP, type AttributeDialogProps } from './attribute-dialog.tsx'

export {
  ATTRIBUTE_TYPE_CHOICES,
  typeIcon,
  typeLabel,
  typeMeta,
  type AttributeTypeMeta,
} from './type-meta.ts'

export { useAttributeDefinitions, groupsOf, takenSlugs } from './use-definitions.ts'

export { useCreateAttribute, useUpdateAttribute } from './use-attribute-mutations.ts'
