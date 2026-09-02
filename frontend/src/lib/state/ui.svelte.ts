/**
 * UI open-state store for cross-component dialogs (diff drawer, artifact
 * export/import dialogs, history drawer).
 *
 * Exposed as accessor functions to match the convention used in the other
 * `*.svelte.ts` stores in this folder.
 */

let _diffDrawerOpen: boolean = $state(false);

export function getDiffDrawerOpen(): boolean {
	return _diffDrawerOpen;
}

export function setDiffDrawerOpen(open: boolean): void {
	_diffDrawerOpen = open;
}

let _historyDrawerOpen: boolean = $state(false);

export function getHistoryDrawerOpen(): boolean {
	return _historyDrawerOpen;
}

export function setHistoryDrawerOpen(open: boolean): void {
	_historyDrawerOpen = open;
}

// Artifact export/import dialogs (mounted once in ArtifactsMenu, opened from
// two surfaces: the TopBar Artifacts menu and each artifact editor's own
// toolbar export button — which passes a seed selection). Both surfaces
// live inside the workspace, so the dialogs are only ever opened while
// ArtifactsMenu is mounted; the open flags below are still module state
// (not local to ArtifactsMenu) purely so an editor toolbar's export button
// can reach them without prop-drilling through the workspace tree.
//
// ArtifactsMenu owns the flags' lifecycle regardless: it clears both on
// mount (a flag latched by a stale render before the dialogs existed must
// not pop a dialog open on project entry) and again on unmount (leaving the
// workspace with a dialog open — e.g. browser Back — must not carry the
// open flag into the next project entry). See the lifecycle comment in
// ArtifactsMenu.svelte; that guard is unchanged and still load-bearing.
let _exportArtifactsOpen: boolean = $state(false);
let _exportArtifactsSeed: string[] = $state([]);
let _importArtifactsOpen: boolean = $state(false);

export function getExportArtifactsOpen(): boolean {
	return _exportArtifactsOpen;
}

export function getExportArtifactsSeed(): string[] {
	return _exportArtifactsSeed;
}

/** Open the export dialog, pre-checking `seedRootIds`. Unknown ids are
 * ignored by the dialog itself — it intersects the seed with the committed
 * headers of the kinds it renders, so an id of an unregistered kind (legacy
 * `diagram`) is dropped just like an unknown one. */
export function openExportArtifacts(seedRootIds: string[] = []): void {
	_exportArtifactsSeed = seedRootIds;
	_exportArtifactsOpen = true;
}

export function setExportArtifactsOpen(open: boolean): void {
	_exportArtifactsOpen = open;
	if (!open) _exportArtifactsSeed = [];
}

export function getImportArtifactsOpen(): boolean {
	return _importArtifactsOpen;
}

export function setImportArtifactsOpen(open: boolean): void {
	_importArtifactsOpen = open;
}

export function openImportArtifacts(): void {
	_importArtifactsOpen = true;
}

// Add/Delete view dialogs — mounted once in ViewMenu, which owns the flags'
// lifecycle exactly as ArtifactsMenu owns the artifact dialogs' (see above).
let _addViewOpen: boolean = $state(false);
let _deleteViewOpen: boolean = $state(false);

export function getAddViewOpen(): boolean {
	return _addViewOpen;
}

export function setAddViewOpen(open: boolean): void {
	_addViewOpen = open;
}

export function openAddView(): void {
	_addViewOpen = true;
}

export function getDeleteViewOpen(): boolean {
	return _deleteViewOpen;
}

export function setDeleteViewOpen(open: boolean): void {
	_deleteViewOpen = open;
}

export function openDeleteView(): void {
	_deleteViewOpen = true;
}
