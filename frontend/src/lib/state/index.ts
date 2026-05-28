export {
	TEMP_ID_PREFIX,
	createTempId,
	isTempId,
	type ElementOp,
	type Op,
	type RelationshipOp,
	type Snapshot
} from './ops';
export { ApplyError, apply } from './apply';
export { computeDiff, deepEqual, type Diff, type EntityDiff, type EntityStatus } from './diff';
export { getBaseline, setBaseline } from './baseline.svelte';
export { emit, getPendingOps, resetOps, undoLast } from './pending.svelte';
export { getDiff, getWorkingModel } from './working.svelte';
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
	getActiveTab,
	setActiveTab,
	type WorkspaceTab
} from './workspace.svelte';
export {
	clearMetamodel,
	getMetamodel,
	getMetamodelName,
	setMetamodel
} from './metamodel.svelte';
export {
	clearFilters,
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
