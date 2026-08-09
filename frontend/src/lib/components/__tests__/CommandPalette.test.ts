import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import * as modelRead from '$lib/api/model-read';
import {
	getCommandPaletteOpen,
	getExportArtifactsOpen,
	getImportArtifactsOpen,
	setCommandPaletteOpen,
	setExportArtifactsOpen,
	setImportArtifactsOpen,
	setProjectInfo
} from '$lib/state';
import { resetCheckout } from '$lib/state/checkout.svelte';
import CommandPalette from '../CommandPalette.svelte';

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

beforeEach(() => {
	resetCheckout();
	// No model is loaded in these tests (getModelSummary() is null), so the
	// palette's entity-search effect never fires — the spy is a guard, not a
	// fixture.
	vi.spyOn(modelRead, 'listElementsPage').mockResolvedValue({ items: [], total: 0 });
	host = document.createElement('div');
	document.body.appendChild(host);
});

afterEach(() => {
	if (app) unmount(app);
	app = null;
	setCommandPaletteOpen(false);
	setExportArtifactsOpen(false);
	setImportArtifactsOpen(false);
	host.remove();
	vi.restoreAllMocks();
});

function openPalette(role: 'editor' | 'viewer') {
	setProjectInfo({ role, lockTtlSeconds: 300 });
	app = mount(CommandPalette, { target: host });
	setCommandPaletteOpen(true);
	flushSync();
}

// bits-ui renders each Command.Item as a `display: contents` wrapper carrying
// data-value, with the actual item element (the one holding the onclick that
// fires onSelect) as its child — so interaction tests must click the child.
function itemByValue(value: string): HTMLElement | null {
	return document.body.querySelector<HTMLElement>(`[data-value="${value}"] > *`);
}

describe('CommandPalette', () => {
	it('offers both artifact actions to an editor', () => {
		openPalette('editor');
		expect(itemByValue('action:export-artifacts')).not.toBeNull();
		expect(itemByValue('action:import-artifacts')).not.toBeNull();
	});

	// Viewer gating is hide-not-disable, mirroring ArtifactsMenu: import is a
	// write (plan/import are editor-only routes), export is a viewer-allowed
	// read and must stay visible.
	it('hides the import action from a viewer but keeps export', () => {
		openPalette('viewer');
		expect(itemByValue('action:export-artifacts')).not.toBeNull();
		expect(itemByValue('action:import-artifacts')).toBeNull();
	});

	it('selecting Export closes the palette and opens the export dialog', () => {
		openPalette('editor');
		itemByValue('action:export-artifacts')!.click();
		flushSync();
		expect(getCommandPaletteOpen()).toBe(false);
		expect(getExportArtifactsOpen()).toBe(true);
	});

	it('selecting Import closes the palette and opens the import dialog', () => {
		openPalette('editor');
		itemByValue('action:import-artifacts')!.click();
		flushSync();
		expect(getCommandPaletteOpen()).toBe(false);
		expect(getImportArtifactsOpen()).toBe(true);
	});
});
