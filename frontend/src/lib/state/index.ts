export {
	TEMP_ID_PREFIX,
	createTempId,
	isTempId,
	type ElementOp,
	type Op,
	type RelationshipOp,
	type Snapshot
} from './ops';
export { mergePatch } from './apply';
export { computeDiff, deepEqual, type Diff, type EntityDiff, type EntityStatus } from './diff';
export {
	getFilename,
	setFilename,
	getMetamodelFilename,
	setMetamodelFilename,
	getViewFilename,
	setViewFilename,
	getFileHandle,
	setFileHandle,
	getViewFileHandle,
	setViewFileHandle
} from './file.svelte';
export {
	adoptSummary,
	applyDelta,
	clearModelError,
	emit,
	ensureElement,
	ensureElements,
	ensureRelationship,
	flushNow,
	getCachedElements,
	getCachedRelationships,
	getIssueCounts,
	getIssuesByOwner,
	getModelError,
	getModelGeneration,
	getModelRev,
	getModelSummary,
	getStructureRev,
	getUndoDepth,
	hasPendingOps,
	loadSummary,
	refreshSummary,
	resetModelStore,
	seedElements,
	seedRelationships,
	undo,
	validateAll,
	getStagedOps,
	getStagedOpsFor,
	getStagedDepth,
	hasStagedOps,
	getStagedDiff,
	getStagedChangeCount,
	revertStagedFor,
	revertAllStaged,
	popLastStaged,
	clearStaged,
	setModelError,
	type ModelStoreError
} from './model.svelte';
export {
	changesDocToDiff,
	clearChangesBadge,
	getChangesBadge,
	getChangesBadgeTotal,
	refreshChangesBadge
} from './changes.svelte';
export {
	clearSelection,
	getSelection,
	select,
	type Selection,
	type SelectionKind
} from './selection.svelte';
export {
	clearIssues,
	getIssues,
	getLastError,
	getLastRunAt,
	isRunning,
	setIssues,
	setLastError,
	setRunning
} from './validation.svelte';
export { indexIssues, worstSeverityFor, type IssueIndex } from './validation-index';
export { getActiveTab, setActiveTab, type WorkspaceTab } from './workspace.svelte';
export { clearMetamodel, getMetamodel, setMetamodel } from './metamodel.svelte';
export {
	clearFilters,
	ensureTypeFilterInitialized,
	getSearchText,
	getTypeFilter,
	setSearchText,
	setTypeFilter,
	toggleType
} from './filters.svelte';
export {
	getCommandPaletteOpen,
	getDiffDrawerOpen,
	setCommandPaletteOpen,
	setDiffDrawerOpen
} from './ui.svelte';
export {
	getFeedConnected,
	getLockFor,
	getLockState,
	getPresence,
	onLockEvent,
	startRealtime,
	stopRealtime
} from './realtime.svelte';
export {
	setCheckoutApiConfig, setProjectInfo, getRole, canEdit, ensureCheckout,
	getHeldToken, getHeldTokens, isCheckedOutByMe, resetCheckout,
	loadProjectInfo, getStaleResources, clearStaleResource, handleRemoteLockEvent,
	previewStaged, commitStaged, discardElement, discardAll,
	type CheckoutResult, type LockConflictLite
} from './checkout.svelte';
export { editLock, connectLock, deleteLock } from './edit-gate';
export { getLockNotice, setLockNotice } from './lock-notice.svelte';
export {
	addSearchCriterion,
	availableCriterionTypes,
	clearSearchCriteria,
	closeResultsPanel,
	commitSearchResults,
	getDraftQuery,
	getResultsPanelOpen,
	getSearchCriteria,
	getSearchDialogOpen,
	getSearchResults,
	getSearchResultsNote,
	getSearchResultsTarget,
	getSearchTarget,
	removeSearchCriterion,
	setSearchDialogOpen,
	setSearchTarget,
	updateSearchCriterion
} from './advanced-search.svelte';
export {
	clearViewState,
	cloneView,
	createFolder,
	deleteFolder,
	dropView,
	getView,
	getViewChanges,
	getViewChangesCount,
	getViewWarnings,
	moveFolder,
	placeElement,
	placeElements,
	placeElementsAt,
	pushView,
	refreshView,
	removeElement,
	renameFolder,
	setViewBaseline
} from './view.svelte';
export type { ViewChange } from './view-diff';
export {
	formatViewChange,
	viewChangeSegments,
	type ViewChangeSegment,
	type ViewChangeSegmentKind
} from './view-change-format';
