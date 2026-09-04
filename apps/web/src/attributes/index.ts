/**
 * `@/attributes` — how a user-defined field becomes something on a screen.
 *
 * Two registries and the rules they share (ADR-052). Everything a feature needs to render or edit
 * an attribute is here; nothing here knows the name of a single field.
 */
export { AttributeCell, ATTRIBUTE_CELLS, EmptyValue } from './attribute-cell.tsx'
export type {
  AttributeCellProps,
  AttributeCellRegistry,
  AttributeCellRenderer,
} from './attribute-cell.tsx'

export {
  ATTRIBUTE_INPUTS,
  AttributeField,
  AttributeInput,
  controlFor,
  isEditable,
  uiFor,
} from './attribute-input.tsx'
export type { AttributeInputRegistry } from './attribute-input.tsx'
export type { AttributeInputControl, AttributeInputProps } from './input-props.ts'

export {
  DisplayProvider,
  defaultRecordHref,
  useDisplay,
  type DisplaySettings,
} from './display-context.tsx'

export {
  formatCivilDate,
  formatDateTime,
  formatNumber,
  formatPhone,
  formatRelativeDay,
  mailtoHref,
  phoneHref,
  prettyUrl,
  type NumberDisplay,
} from './format.ts'

export {
  attributeTypeOf,
  coreOptions,
  draftFromWriteValue,
  isEmptyDraft,
  numberDisplayOf,
  relationConfigOf,
  toDraft,
  toWriteValue,
  typeContextFor,
  validateDraft,
  type AttributeDraft,
  type AttributeDraftByType,
  type AttributeOptionLike,
  type AttributeReadValue,
  type AttributeSpec,
} from './value.ts'

export {
  ATTRIBUTE_FIELD_PREFIX,
  attributeFieldError,
  attributeFieldErrors,
  fieldErrors,
  isFieldLevelFailure,
} from './errors.ts'

export { useTagSuggestions } from './suggestions.ts'
export {
  cycleTriState,
  triStateLabel,
  TRI_STATE_ORDER,
  type TriState,
} from './controls/tri-state-model.ts'
export {
  addTags,
  containsTag,
  isNewTag,
  parseTagInput,
  removeTag,
  suggestTags,
} from './controls/tag-input-model.ts'
