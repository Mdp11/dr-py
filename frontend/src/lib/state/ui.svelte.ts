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
