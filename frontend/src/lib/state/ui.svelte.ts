/**
 * UI open-state store for cross-component dialogs (diff drawer, command palette).
 *
 * Exposed as accessor functions to match the convention used in the other
 * `*.svelte.ts` stores in this folder.
 */

let _diffDrawerOpen: boolean = $state(false);
let _commandPaletteOpen: boolean = $state(false);

export function getDiffDrawerOpen(): boolean {
	return _diffDrawerOpen;
}

export function setDiffDrawerOpen(open: boolean): void {
	_diffDrawerOpen = open;
}

export function getCommandPaletteOpen(): boolean {
	return _commandPaletteOpen;
}

export function setCommandPaletteOpen(open: boolean): void {
	_commandPaletteOpen = open;
}

let _historyDrawerOpen: boolean = $state(false);

export function getHistoryDrawerOpen(): boolean {
	return _historyDrawerOpen;
}

export function setHistoryDrawerOpen(open: boolean): void {
	_historyDrawerOpen = open;
}

// Artifact export/import dialogs (mounted once in ArtifactsMenu, opened from
// three surfaces: the TopBar menu, the command palette, and the workspace tab
// strip's per-artifact export button — which passes a seed selection).
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
