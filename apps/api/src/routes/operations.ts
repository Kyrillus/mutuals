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

  // -- Stage 6 (§4.8). `ask` is built; the other two answer 501 until the second half ------------
  'ask',
  'search',
  'quickCapture',
] as const

export type OperationId = (typeof OPERATIONS)[number]

/**
 * ADR-031's remaining names, kept here so the complete surface stays reviewable while the routes
 * that implement them do not exist yet.
 *
 * **Empty again after Stage 6's first half.** `search` and `quickCapture` are *registered* rather
 * than planned — they have been answering a documented 501 since Stage 1, which is the point of
 * ADR-031's list: the surface is reviewable before the engine is fitted. The one name Stage 6's
 * second half will add is §6.5's on-demand summary, and it goes here the moment its route exists
 * rather than being remembered.
 *
 * The array stays because the test that keeps it disjoint from `OPERATIONS` is the guard that made
 * this list worth keeping.
 */
export const PLANNED_OPERATIONS = ['generateContactSummary'] as const

export type PlannedOperationId = (typeof PLANNED_OPERATIONS)[number]

export const OPERATION_SET: ReadonlySet<string> = new Set<string>(OPERATIONS)
