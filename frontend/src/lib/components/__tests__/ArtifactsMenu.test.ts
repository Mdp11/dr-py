import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import * as artifactsApi from '$lib/api/artifacts';
import {
	getArtifactDialogsHosted,
	getExportArtifactsOpen,
	getImportArtifactsOpen,
	openExportArtifacts,
	openImportArtifacts,
	resetArtifacts,
	setProjectInfo
} from '$lib/state';
import { resetCheckout } from '$lib/state/checkout.svelte';
import ArtifactsMenu from '../ArtifactsMenu.svelte';

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

beforeEach(() => {
	resetArtifacts();
	resetCheckout();
	vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({ items: [] });
	host = document.createElement('div');
	document.body.appendChild(host);
});

afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	vi.restoreAllMocks();
});

function openMenu(role: 'editor' | 'viewer') {
	setProjectInfo({ role, lockTtlSeconds: 300 });
	app = mount(ArtifactsMenu, { target: host });
	flushSync();
	host.querySelector<HTMLButtonElement>('[data-testid="artifacts-menu-trigger"]')!.click();
	flushSync();
}

describe('ArtifactsMenu', () => {
	it('offers Export and Import to an editor', () => {
		openMenu('editor');
		const items = [...document.body.querySelectorAll('[role="menuitem"]')].map((n) =>
			n.textContent?.trim()
		);
		expect(items).toContain('Export…');
		expect(items).toContain('Import…');
	});

	it('hides Import from a viewer', () => {
		openMenu('viewer');
		const items = [...document.body.querySelectorAll('[role="menuitem"]')].map((n) =>
			n.textContent?.trim()
		);
		expect(items).toContain('Export…');
		expect(items).not.toContain('Import…');
	});

	// The export/import open flags are MODULE state and this menu is the only
	// place their dialogs mount (workspace TopBar) — while the command palette
	// mounts in the ROOT layout and can set the flags from anywhere. The menu
	// therefore owns the flags' lifecycle: it registers as their host, clears
	// any flag latched while no dialog was mounted, and closes its dialogs on
	// the way out (browser Back with a dialog open) so nothing latches across
	// project entries.
	it('registers as the artifact-dialogs host while mounted', () => {
		expect(getArtifactDialogsHosted()).toBe(false);
		setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
		app = mount(ArtifactsMenu, { target: host });
		flushSync();
		expect(getArtifactDialogsHosted()).toBe(true);
		unmount(app);
		app = null;
		expect(getArtifactDialogsHosted()).toBe(false);
	});

	it('mounting clears dialog-open flags latched while no dialog was mounted', () => {
		openExportArtifacts(['stale-seed']);
		openImportArtifacts();
		setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
		app = mount(ArtifactsMenu, { target: host });
		flushSync();
		expect(getExportArtifactsOpen()).toBe(false);
		expect(getImportArtifactsOpen()).toBe(false);
	});

	it('unmounting closes an open dialog instead of latching it into the next project', () => {
		setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
		app = mount(ArtifactsMenu, { target: host });
		flushSync();
		openExportArtifacts();
		flushSync();
		expect(getExportArtifactsOpen()).toBe(true);
		unmount(app);
		app = null;
		expect(getExportArtifactsOpen()).toBe(false);
		expect(getImportArtifactsOpen()).toBe(false);
	});
});
