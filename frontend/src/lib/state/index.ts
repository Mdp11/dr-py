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
export { getFilename, setFilename, getFileHandle, setFileHandle } from './file.svelte';
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
	getViewWarnings,
	moveFolder,
	placeElement,
	placeElements,
	pushView,
	refreshView,
	removeElement,
	renameFolder
} from './view.svelte';
