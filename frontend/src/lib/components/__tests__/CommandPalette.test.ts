import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import * as modelRead from '$lib/api/model-read';
import {
	adoptSummary,
	getCommandPaletteOpen,
	getExportArtifactsOpen,
	getImportArtifactsOpen,
	resetModelStore,
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
	resetModelStore();
	// The entity-search effect fires whenever the palette is open with a
	// model loaded; an empty page keeps the Entities group unrendered.
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
	resetModelStore();
	host.remove();
	vi.restoreAllMocks();
});

function openPalette(role: 'editor' | 'viewer', { withModel = true } = {}) {
	setProjectInfo({ role, lockTtlSeconds: 300 });
	if (withModel) {
		adoptSummary({
			model_rev: 1,
			element_count: 0,
			relationship_count: 0,
			elements_by_type: {},
			issue_counts: null,
			undo_depth: 0
		});
	}
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

	// The palette mounts in the ROOT layout (Cmd+K works on /projects too),
	// but the export/import dialogs mount only inside the workspace TopBar.
	// Selecting either action with no dialog mounted would latch the
	// module-level open flag with nothing to reset it, popping the dialog
	// open unprompted on the next project entry — so the items must not
	// exist outside a loaded project.
	it('offers no artifact actions when no model is loaded', () => {
		openPalette('editor', { withModel: false });
		expect(itemByValue('action:export-artifacts')).toBeNull();
		expect(itemByValue('action:import-artifacts')).toBeNull();
	});
});
