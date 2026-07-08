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
	dropTreeItems,
	emit,
	ensureElement,
	ensureElements,
	ensureRelationship,
	ensureTreeItems,
	getCachedElements,
	getCachedRelationships,
	getCachedTreeItems,
	getIssueCounts,
	getIssuesByOwner,
	getModelError,
	getMissingElementIds,
	getModelGeneration,
	getModelRev,
	getModelSummary,
	getStructureRev,
	getTreeElements,
	loadSummary,
	refreshSummary,
	resetModelStore,
	seedElements,
	seedRelationships,
	seedTreeItems,
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
export {
	BUILTIN_TABS,
	bindTabToArtifact,
	closeTab,
	getActiveTab,
	getDynamicTabs,
	initWorkspaceTabs,
	openNavigationTab,
	resetWorkspaceTabs,
	retitleTab,
	setActiveTab,
	type DynamicTab,
	type WorkspaceTab
} from './workspace.svelte';
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
	getHistoryDrawerOpen,
	setCommandPaletteOpen,
	setDiffDrawerOpen,
	setHistoryDrawerOpen
} from './ui.svelte';
export {
	getFeedConnected,
	getFeedTermination,
	getLockFor,
	getLockState,
	getPresence,
	onLockEvent,
	startRealtime,
	stopRealtime
} from './realtime.svelte';
export {
	setCheckoutApiConfig,
	setProjectInfo,
	getRole,
	getStrictMode,
	setStrictMode,
	canEdit,
	ensureCheckout,
	getHeldToken,
	getHeldTokens,
	isCheckedOutByMe,
	resetCheckout,
	loadProjectInfo,
	getStaleResources,
	clearStaleResource,
	handleRemoteLockEvent,
	previewStaged,
	commitStaged,
	discardElement,
	discardAll,
	type CheckoutResult,
	type LockConflictLite
} from './checkout.svelte';
export { editLock, connectLock, deleteLock } from './edit-gate';
export { lockBadgeFor, type LockBadge } from './lock-badge';
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
	moveArtifact,
	moveFolder,
	placeArtifact,
	placeElement,
	placeElements,
	placeElementsAt,
	pushView,
	refreshView,
	removeArtifactFromFolder,
	removeElement,
	renameFolder,
	setViewBaseline
} from './view.svelte';
export type { ViewChange } from './view-diff';
export {
	artifactHeaderById,
	createNavigationArtifact,
	getArtifactHeaders,
	getArtifactsLoading,
	loadArtifacts,
	removeArtifact,
	renameArtifact,
	resetArtifacts
} from './artifacts.svelte';
export {
	closeDraft,
	emptyPath,
	ensureDraft,
	getDraft,
	getEvalError,
	getPreview,
	getSaveConflict,
	isExpanded,
	isRunnable,
	loadMorePreview,
	reloadDraft,
	resetNavigationEditors,
	runPreview,
	saveDraft,
	setDraftName,
	toggleExpanded,
	updateDefinition,
	type NavDraft,
	type NavPreview
} from './navigation-editor.svelte';
export { getCurrentUser, isAdmin, fetchMe, signIn, signOut } from './auth.svelte';
export { getActiveProjectId, setActiveProject, clearActiveProject } from './active-project.svelte';
export { installSessionRecovery, recoverFromUnauthorized } from './session-recovery';
export {
	getAccessNotice,
	setAccessNotice,
	clearAccessNotice,
	reactToBootError
} from './access-notice.svelte';
export {
	formatViewChange,
	viewChangeSegments,
	type ViewChangeSegment,
	type ViewChangeSegmentKind
} from './view-change-format';
