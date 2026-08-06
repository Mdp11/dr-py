export {
	ARTIFACT_RESOURCE_PREFIX,
	TEMP_ID_PREFIX,
	artifactResource,
	createTempId,
	isArtifactResource,
	isTempId,
	type ArtifactOp,
	type ElementOp,
	type ModelOp,
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
	backEntries,
	canGoBack,
	canGoForward,
	forwardEntries,
	getVisitCursor,
	getVisitStack,
	goBack,
	goForward,
	goToVisit,
	noteResolved,
	pushVisit,
	remapVisitIds,
	resetInspectionHistory,
	type VisitEntry,
	type VisitMenuEntry
} from './inspection-history.svelte';
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
	revertStagedForElement,
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
	getMultiSelectedIds,
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
	openArtifactTab,
	openNavigationTab,
	repointTabArtifact,
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
	discardElementCascade,
	discardAll,
	reacquireOpenArtifactLeases,
	releaseArtifactIfUnneeded,
	type CheckoutResult,
	type LockConflictLite
} from './checkout.svelte';
export {
	acquireLocks,
	acquireArtifactLease,
	artifactDeleteLock,
	editLock,
	connectLock,
	deleteLock,
	lockHolderLabel
} from './edit-gate';
export { stageSnippetOps, type StageOutcome } from './snippet-stage';
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
	isViewResolved,
	markViewUnresolved,
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
export { isProjectOpening, setProjectOpening } from './project-open.svelte';
export type { ViewChange } from './view-diff';
export {
	artifactHeaderById,
	assertNoNameClash,
	createCodeSnippetArtifact,
	createNavigationArtifact,
	createTableArtifact,
	getArtifactHeaders,
	getArtifactsLoading,
	loadArtifacts,
	removeArtifact,
	renameArtifact,
	resetArtifacts,
	type CodeSnippetPayload
} from './artifacts.svelte';
export {
	applyStructuralEdit,
	closeDraft,
	ensureDraft,
	ensureEmbeddedDraft,
	getDraft,
	getEvalError,
	getNavLockHolder,
	getPreview,
	getSelectedPath,
	hasDirtyNavDrafts,
	isCardCollapsed,
	isNodeVisible,
	isRunnable,
	loadMorePreview,
	registerVisibleNode,
	reloadDraft,
	resetNavigationEditors,
	retryNavLock,
	runPreview,
	saveAsDraft,
	saveDraft,
	selectNode,
	setCardCollapsed,
	setDraftName,
	setEmbeddedRowElement,
	unregisterVisibleNode,
	updateDefinition,
	type EmbeddedContext,
	type NavDraft,
	type NavPreview
} from './navigation-editor.svelte';
export {
	addSnippetElement,
	clearSnippetElements,
	closeSnippetDraft,
	ensureSnippetDraft,
	getSnippetDraft,
	getSnippetLint,
	getSnippetRun,
	getSnippetSaveConflict,
	hasDirtySnippetDrafts,
	LINT_DEBOUNCE_MS,
	markRunStaged,
	reloadSnippetDraft,
	removeSnippetElement,
	resetSnippetEditors,
	runSnippetTab,
	saveSnippetDraft,
	setSnippetEntry,
	setSnippetName,
	stopSnippetTab,
	updateSnippetCode,
	type SnippetBoundElement,
	type SnippetDraft,
	type SnippetLintState,
	type SnippetRunPhase,
	type SnippetRunState
} from './snippet-editor.svelte';
export { ensureSnippetDocs, getSnippetDocs, resetSnippetDocs } from './snippet-docs.svelte';
export {
	abandonTableEvaluationSuspension,
	canRequestScriptErrors,
	closeTableDraft,
	consumeScrollRequest,
	downloadTable,
	ensureTableDraft,
	ensureTableRange,
	getScriptErrors,
	getScriptErrorsPhase,
	getTableDraft,
	getTableError,
	getTableLoading,
	getTableLockHolder,
	getTablePage,
	getTableScriptStatus,
	getTableSort,
	getTableWarnings,
	getUncomputedScriptCellReason,
	hasDirtyTableDrafts,
	hasSuspendedTableEdits,
	loadTablePage,
	reloadTableDraft,
	remapTableSortForInsert,
	remapTableSortForMove,
	remapTableSortForRemove,
	requestScriptErrors,
	requestScrollToCell,
	resetTableEditors,
	restoreTableExportSettings,
	resumeTableEvaluation,
	retryTableLock,
	revertSuspendedTableEdits,
	saveAsTableDraft,
	saveTableDraft,
	setTableName,
	setTableSort,
	suspendTableEvaluation,
	updateTableDefinition,
	updateTableExportSettings,
	type ExportProgress,
	type TableData,
	type TableDraft
} from './table-editor.svelte';
export { hasUnsavedWork, isArtifactDirty, isTabDirty } from './unsaved';
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
export {
	startProgress,
	updateProgress,
	setProgressLabel,
	setProgressIndeterminate,
	endProgress,
	getActiveProgress,
	resetProgress,
	type ProgressEntry
} from './progress.svelte';
export { cancelOpenProgress, trackOpenProgress } from './open-progress.svelte';
export {
	beginJourney,
	journeyUpload,
	journeyStatus,
	finishJourney,
	cancelJourney
} from './open-journey';
export {
	deriveStagedElementRows,
	stagedRelationshipOpIds,
	type StagedElementRow,
	type StagedRowStatus
} from './staged-rows';
export {
	isSnippetExpanded,
	seedSnippetExpanded,
	setSnippetExpanded,
	resetSnippetCollapse
} from './snippet-collapse.svelte';
export {
	getInlineEditorHeight,
	setInlineEditorHeight,
	getSnippetSplitRatio,
	setSnippetSplitRatio,
	resetEditorSize
} from './editor-size.svelte';
export {
	clearStagedArtifacts,
	discardAllStagedArtifacts,
	getStagedArtifactDepth,
	getStagedArtifactEntries,
	getStagedArtifactOps,
	hasStagedArtifactOp,
	notifyArtifactCommit,
	onArtifactCommit,
	onArtifactStageDiscarded,
	onArtifactStagedDelete,
	overlayArtifactHeaders,
	resetArtifactEdits,
	revertStagedArtifact,
	stageArtifactCreate,
	stageArtifactDelete,
	stageArtifactUpdate,
	stagedArtifactState,
	stagedCreateSourceTab,
	type ArtifactCommitInfo,
	type StagedArtifactEntry
} from './artifact-edits.svelte';
