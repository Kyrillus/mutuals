/**
 * Every operation the API offers, by name (ADR-031).
 *
 * §7 asks that "every operation the UI performs is a single, well-named API operation, not a
 * sequence of UI-only calls" — the sentence the MCP-adapter claim rests on. CI cannot prove that:
 * no check can see a UI action that has no operation. So the *list* is the reviewable artifact, and
 * `operations.test.ts` proves the two things a machine can: every registered route appears here,
 * and every name here is registered. A route added without a name, or a name left behind by a
 * deleted route, fails the build.
 *
 * {@link PLANNED_OPERATIONS} holds the names ADR-031 enumerates that later stages will register.
 * They are written down rather than remembered, and the test asserts the two lists are disjoint —
 * so the day the import wizard lands, `createImportBatch` moves from one array to the other and
 * cannot quietly be invented under a second name.
 */

export const OPERATIONS = [
  // -- Contacts (§6.2, §6.5) --------------------------------------------------------------------
  'listContacts',
  'getContact',
  'createContact',
  'updateContact',
  'deleteContact',
  'bulkDeleteContacts',
  'bulkUpdateContactAttribute',
  'getContactConnections',
  'previewMergeContacts',
  'mergeContacts',
  // §6.5's summary. Two operations, not one: the read runs on every visit to a contact's page and
  // the write spends money, so folding them together would put a billable call behind a page load.
  'getContactSummary',
  'generateContactSummary',

  // -- Records, whatever kind (§4.5) -------------------------------------------------------------
  'getValueHistory',

  // -- Organizations (§6.3) ---------------------------------------------------------------------
  'listOrganizations',
  'getOrganization',
  'createOrganization',
  'updateOrganization',
  'deleteOrganization',
  'mergeOrganizations',

  // -- Interactions (§6.5) ----------------------------------------------------------------------
  'listInteractions',
  'createInteraction',
  'updateInteraction',
  'deleteInteraction',

  // -- Follow-ups (§6.4) ------------------------------------------------------------------------
  'listFollowUps',
  'createFollowUp',
  'updateFollowUp',
  'deleteFollowUp',
  'bulkUpdateFollowUps',

  // -- Attribute definitions (§6.7) -------------------------------------------------------------
  'listAttributeDefinitions',
  'createAttributeDefinition',
  'updateAttributeDefinition',
  'deleteAttributeDefinition',
  'previewDeleteAttributeDefinition',

  // -- Saved views (§6.6) -----------------------------------------------------------------------
  'listViews',
  'createView',
  'updateView',
  'deleteView',

  // -- The import wizard (§6.8) -----------------------------------------------------------------
  'createImportBatch',
  'getImportBatch',
  // Not in ADR-031's list. It reserved an operation for editing one row and none for step 3's
  // `Confirm mapping`, which is the wizard's central act — see ADR-098. The alternative was
  // overloading `updateImportRow`, which is the "second name for one thing" this file exists to
  // prevent.
  'updateImportBatch',
  'updateImportRow',
  'revertImportRow',
  'replaceInImportBatch',
  'exportImportBatch',
  'commitImportBatch',
  'getImportErrorReport',

  // -- Dashboard and settings (§6.1, §6.6) ------------------------------------------------------
  'getStats',
  'getProfile',
  'updateProfile',
  // Not in ADR-031's list. ADR-070 names it: a cost cap with no way to see what it is counting is
  // a number nobody can check, and "a bug that loops spends someone's real money" is the whole
  // reason the cap exists.
  'getLlmStats',

  // -- Stage 6 (§4.8, §6.10) ---------------------------------------------------------------------
  'ask',
  'search',
  'quickCapture',
  // Confirming a capture is one user action, so it is one operation — §7's "not a sequence of
  // UI-only calls", which is the sentence the MCP-adapter claim rests on.
  'commitQuickCapture',
] as const

export type OperationId = (typeof OPERATIONS)[number]

/**
 * ADR-031's remaining names, kept here so the complete surface stays reviewable while the routes
 * that implement them do not exist yet.
 *
 * **Empty as of Stage 6.** Every name ADR-031 enumerated is registered, and the three added along
 * the way — `updateImportBatch` (ADR-098), `getLlmStats` (ADR-070) and `commitQuickCapture` (§7) —
 * are each argued in an ADR rather than smuggled in.
 *
 * The array stays because the test that keeps it disjoint from `OPERATIONS` is the guard that made
 * this list worth keeping.
 */
export const PLANNED_OPERATIONS = [] as const

export type PlannedOperationId = (typeof PLANNED_OPERATIONS)[number]

export const OPERATION_SET: ReadonlySet<string> = new Set<string>(OPERATIONS)
