export {
	ARTIFACT_RESOURCE_PREFIX,
	FOLDER_RESOURCE_PREFIX,
	TEMP_ID_PREFIX,
	VIEW_ROOT_ID,
	artifactResource,
	createTempId,
	folderResource,
	isArtifactResource,
	isFolderResource,
	isTempId,
	type ArtifactOp,
	type ElementOp,
	type ModelOp,
	type Op,
	type RelationshipOp,
	type Snapshot,
	type ViewOp
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
	getIssuesTruncatedTotal,
	getLiveIssues,
	adoptIssues,
	refetchIssues,
	getModelError,
	getMissingElementIds,
	isStagedDeleted,
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
	clearOverlay,
	getOverlay,
	getLastError,
	getLastRunAt,
	isRunning,
	setOverlay,
	setLastError,
	setRunning
} from './validation.svelte';
export { getEffectiveIssues } from './issue-source';
export { indexIssues, worstSeverityFor, type IssueIndex } from './validation-index';
export {
	bindTabToArtifact,
	closeTab,
	getActiveTab,
	getDynamicTabs,
	initWorkspaceTabs,
	openArtifactTab,
	openIssuesTab,
	openMetamodelTab,
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
	getDiffDrawerOpen,
	getExportArtifactsOpen,
	getExportArtifactsSeed,
	getHistoryDrawerOpen,
	getImportArtifactsOpen,
	openExportArtifacts,
	openImportArtifacts,
	setDiffDrawerOpen,
	setExportArtifactsOpen,
	setImportArtifactsOpen,
	setHistoryDrawerOpen
} from './ui.svelte';
export {
	getFeedConnected,
	getFeedTermination,
	getLockFor,
	getLockState,
	getPresence,
	hasModelLocks,
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
	discardArtifact,
	discardElement,
	discardElementCascade,
	discardAll,
	reacquireOpenArtifactLeases,
	releaseArtifactIfUnneeded,
	releaseFolderLeaseIfUnneeded,
	releaseMetamodelLease,
	type CheckoutResult,
	type LockConflictLite
} from './checkout.svelte';
export {
	acquireMetamodelLease,
	dropMetamodelLease,
	getMetamodelLockHolder
} from './metamodel-lease.svelte';
export {
	closeMetamodelEditor,
	discardMetamodelDraft,
	editMetamodelBuffer,
	getMetamodelEditor,
	initMetamodelEditor,
	isMetamodelEditorDirty,
	METAMODEL_DRAFT_DEBOUNCE_MS,
	METAMODEL_LINT_DEBOUNCE_MS,
	previewMetamodelChanges,
	resetMetamodelEditor,
	retryMetamodelLease,
	type MetamodelEditorView
} from './metamodel-editor.svelte';
export {
	clearStagedNodeMoves,
	closeMetamodelStage,
	discardStagedNodeMoves,
	getStagedMetamodelDepth,
	getStagedMetamodelOps,
	getStagedNodeMoves,
	initMetamodelStage,
	notifyMetamodelCommitted,
	notifyMetamodelDiscardAll,
	onMetamodelCommitted,
	onMetamodelDiscardAll,
	registerMetamodelDraftProvider,
	stageNodeMove,
	type MetamodelCommitInfo,
	type NodePos
} from './metamodel-stage.svelte';
export {
	applyDiagramEdit,
	closeMetamodelDiagram,
	getMetamodelDiagramView,
	initMetamodelDiagram,
	moveNode,
	onMetamodelRebound,
	runAutoArrange,
	selectDiagramNode,
	setAllCollapsed,
	setMetamodelView,
	toggleNodeCollapsed,
	undoDiagramEdit,
	type MetamodelDiagramView
} from './metamodel-diagram.svelte';
export {
	acquireLocks,
	acquireArtifactLease,
	artifactDeleteLock,
	artifactEditLock,
	editLock,
	connectLock,
	deleteLock,
	folderCreateLock,
	folderDeleteLock,
	folderEditLock,
	folderTargets,
	lockHolderLabel
} from './edit-gate';
export { stageSnippetOps, type StageOutcome } from './snippet-stage';
export { lockBadgeFor, type LockBadge } from './lock-badge';
export { getLockNotice, setLockNotice } from './lock-notice.svelte';
export {
	getViewDiscardNotice,
	setViewDiscardNotice,
	clearViewDiscardNotice
} from './view-discard-notice.svelte';
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
	applyViewOp,
	artifactPlacementFolderIds,
	elementHomeFolderId,
	findFolderById,
	findFolderContainer,
	folderSubtreeIds,
	isFolderIdAncestor
} from './view-ops';
export {
	clearViewState,
	cloneView,
	discardViewChanges,
	getView,
	getViewWarnings,
	isViewResolved,
	markViewUnresolved,
	refreshView,
	stageClearView,
	stageCreateFolder,
	stageDeleteFolder,
	stageMoveArtifact,
	stageMoveFolder,
	stagePlaceArtifact,
	stagePlaceElementsAt,
	stageRemoveArtifactRef,
	stageRemoveElement,
	stageRenameFolder
} from './view.svelte';
export { isProjectOpening, setProjectOpening } from './project-open.svelte';
export {
	artifactHeaderById,
	assertNoNameClash,
	getArtifactHeaders,
	getArtifactsLoading,
	getCommittedArtifactHeaders,
	loadArtifacts,
	referenceableArtifactHeaders,
	removeArtifact,
	renameArtifact,
	resetArtifacts
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
	setNavLockDenied,
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
	forkSnippetDraftAsCopy,
	getSnippetDraft,
	getSnippetLint,
	getSnippetLockHolder,
	getSnippetRun,
	hasDirtySnippetDrafts,
	LINT_DEBOUNCE_MS,
	markRunStaged,
	reloadSnippetDraft,
	removeSnippetElement,
	resetSnippetEditors,
	retrySnippetLock,
	runSnippetTab,
	saveSnippetDraft,
	setSnippetEntry,
	setSnippetLockDenied,
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
	addExporterEntry,
	closeExporterDraft,
	ensureExporterDraft,
	getExporterDraft,
	getExporterLockHolder,
	hasDirtyExporterDrafts,
	moveExporterEntryInList,
	removeExporterEntry,
	resetExporterEditors,
	retryExporterLock,
	saveExporterDraft,
	setExporterLockDenied,
	setExporterName,
	updateExporterEntry,
	type ExporterDraft
} from './exporter-editor.svelte';
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
	setTableLockDenied,
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
	repointStagedArtifactSourceTab,
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
export { markEditorLockDenied } from './artifact-lock-denied';
export {
	clearStagedView,
	discardStagedView,
	getStagedViewDepth,
	getStagedViewEntries,
	getStagedViewOps,
	notifyViewCommitted,
	onViewCommitted,
	onViewDiscarded,
	resetViewEdits,
	stageViewOp,
	type StagedViewEntry
} from './view-edits.svelte';
export { isProjectQuiet } from './quiet';
