import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import * as modelRead from '$lib/api/model-read';
import {
	getCommandPaletteOpen,
	getExportArtifactsOpen,
	getImportArtifactsOpen,
	setArtifactDialogsHosted,
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
	setArtifactDialogsHosted(false);
	host.remove();
	vi.restoreAllMocks();
});

function openPalette(role: 'editor' | 'viewer', { hosted = true } = {}) {
	setProjectInfo({ role, lockTtlSeconds: 300 });
	// In the app, ArtifactsMenu (workspace TopBar) registers itself as the
	// host of the export/import dialogs while mounted; the palette's artifact
	// actions exist only then.
	setArtifactDialogsHosted(hosted);
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
	// open unprompted on the next project entry — so the items exist only
	// while ArtifactsMenu (the dialogs' host) is mounted. Gating on "a model
	// is loaded" would be wrong in both directions: the model store is never
	// reset on leaving a project, and a metamodel-only project has no
	// summary while its menu is mounted and export works.
	it('offers no artifact actions while no dialog host is mounted', () => {
		openPalette('editor', { hosted: false });
		expect(itemByValue('action:export-artifacts')).toBeNull();
		expect(itemByValue('action:import-artifacts')).toBeNull();
	});
});
