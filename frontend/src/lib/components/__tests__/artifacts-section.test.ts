import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import * as api from '$lib/api/artifacts';
import {
	closeTab,
	getActiveTab,
	getDynamicTabs,
	loadArtifacts,
	openArtifactTab,
	resetArtifacts,
	resetWorkspaceTabs,
	setActiveTab,
	setProjectInfo,
	stageArtifactCreate,
	stageArtifactUpdate
} from '$lib/state';
import { resetCheckout } from '$lib/state/checkout.svelte';
import { endDrag, getDragPayload, isDragActive } from '$lib/state/tree-drag.svelte';
import ArtifactsSection from '../Sidebar/ArtifactsSection.svelte';

const HEADER = {
	id: 'a1',
	kind: 'navigation',
	name: 'Sensors',
	artifact_rev: 1,
	updated_at: '2026-07-05T00:00:00Z',
	updated_by: null,
	entry_points: null
};

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

beforeEach(async () => {
	resetArtifacts();
	resetWorkspaceTabs();
	resetCheckout();
	setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
	vi.spyOn(api, 'listArtifacts').mockResolvedValue({ items: [HEADER] });
	await loadArtifacts();
	host = document.createElement('div');
	document.body.appendChild(host);
});

afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	vi.restoreAllMocks();
	endDrag();
	resetCheckout();
	resetArtifacts();
});

describe('ArtifactsSection', () => {
	it('lists navigation artifacts', () => {
		app = mount(ArtifactsSection, { target: host });
		flushSync();
		expect(host.textContent).toContain('Navigations');
		expect(host.textContent).toContain('Sensors');
	});

	it('double-click opens a navigation tab', async () => {
		app = mount(ArtifactsSection, { target: host });
		flushSync();
		const row = host.querySelector('[data-artifact-id="a1"]');
		expect(row).not.toBeNull();
		row!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		flushSync();
		expect(getDynamicTabs()).toHaveLength(1);
		expect(getDynamicTabs()[0].artifactId).toBe('a1');
	});

	it('a plain pointerdown+pointerup (no movement) does not arm a drag', () => {
		app = mount(ArtifactsSection, { target: host });
		flushSync();
		const row = host.querySelector('[data-artifact-id="a1"]');
		expect(row).not.toBeNull();
		row!.dispatchEvent(
			new PointerEvent('pointerdown', {
				bubbles: true,
				button: 0,
				isPrimary: true,
				clientX: 10,
				clientY: 10
			})
		);
		flushSync();
		expect(isDragActive()).toBe(false);
		window.dispatchEvent(
			new PointerEvent('pointerup', { bubbles: true, button: 0, clientX: 10, clientY: 10 })
		);
		flushSync();
		expect(isDragActive()).toBe(false);
		expect(getDragPayload()).toBeNull();
	});

	it('pointerdown followed by movement past the threshold arms an artifact drag', () => {
		app = mount(ArtifactsSection, { target: host });
		flushSync();
		const row = host.querySelector('[data-artifact-id="a1"]');
		expect(row).not.toBeNull();
		row!.dispatchEvent(
			new PointerEvent('pointerdown', {
				bubbles: true,
				button: 0,
				isPrimary: true,
				clientX: 10,
				clientY: 10
			})
		);
		flushSync();
		expect(isDragActive()).toBe(false);
		window.dispatchEvent(
			new PointerEvent('pointermove', { bubbles: true, clientX: 30, clientY: 10 })
		);
		flushSync();
		expect(isDragActive()).toBe(true);
		expect(getDragPayload()).toEqual({ kind: 'artifact', id: 'a1', artifactKind: 'navigation' });
	});
});

describe('ArtifactsSection staged rows', () => {
	it('lists a staged create with a "new" badge', () => {
		const tempId = stageArtifactCreate('table', 'Draft table', {}, 'tbl:draft:1');
		app = mount(ArtifactsSection, { target: host });
		flushSync();
		const row = host.querySelector(`[data-artifact-id="${tempId}"]`);
		expect(row).not.toBeNull();
		expect(row!.textContent).toContain('Draft table');
		expect(row!.querySelector('[data-staged-state]')?.textContent?.trim()).toBe('new');
	});

	it('shows the staged name and an "edited" badge on a staged rename', () => {
		stageArtifactUpdate('a1', { name: 'Sensors v2' });
		app = mount(ArtifactsSection, { target: host });
		flushSync();
		const row = host.querySelector('[data-artifact-id="a1"]');
		expect(row!.textContent).toContain('Sensors v2');
		expect(row!.querySelector('[data-staged-state]')?.textContent?.trim()).toBe('edited');
	});

	it('renders no badge on an untouched row', () => {
		app = mount(ArtifactsSection, { target: host });
		flushSync();
		const row = host.querySelector('[data-artifact-id="a1"]');
		expect(row!.querySelector('[data-staged-state]')).toBeNull();
	});

	it('double-clicking a staged create focuses its originating tab instead of opening one', () => {
		const sourceTab = openArtifactTab('table', { artifactId: null, title: 'New table' });
		const tempId = stageArtifactCreate('table', 'Draft table', {}, sourceTab);
		setActiveTab('model');
		app = mount(ArtifactsSection, { target: host });
		flushSync();
		host
			.querySelector(`[data-artifact-id="${tempId}"]`)!
			.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		flushSync();
		// No SECOND tab: the draft is already open, and a temp id has no
		// server-side artifact for a fresh tab to load.
		expect(getDynamicTabs().map((t) => t.id)).toEqual([sourceTab]);
		expect(getActiveTab()).toBe(sourceTab);
	});

	it('does not open a tab for a staged create that recorded no originating tab', () => {
		const tempId = stageArtifactCreate('table', 'Draft table', {}, null);
		setActiveTab('model');
		app = mount(ArtifactsSection, { target: host });
		flushSync();
		host
			.querySelector(`[data-artifact-id="${tempId}"]`)!
			.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		flushSync();
		expect(getDynamicTabs()).toHaveLength(0);
		expect(getActiveTab()).toBe('model');
	});

	it('does not activate a staged create whose originating tab has since been closed', () => {
		// Closing an editor tab clears its draft and releases its lease but does
		// NOT revert the staged create, so the recorded source tab id outlives the
		// tab. Activating it would leave the workspace on an id no pane matches.
		const sourceTab = openArtifactTab('table', { artifactId: null, title: 'New table' });
		const tempId = stageArtifactCreate('table', 'Draft table', {}, sourceTab);
		closeTab(sourceTab);
		setActiveTab('model');
		app = mount(ArtifactsSection, { target: host });
		flushSync();
		host
			.querySelector(`[data-artifact-id="${tempId}"]`)!
			.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
		flushSync();
		expect(getDynamicTabs()).toHaveLength(0);
		expect(getActiveTab()).toBe('model');
	});

	it('does not arm a drag from a staged-create row', () => {
		const tempId = stageArtifactCreate('table', 'Draft table', {}, 'tbl:draft:1');
		app = mount(ArtifactsSection, { target: host });
		flushSync();
		const row = host.querySelector(`[data-artifact-id="${tempId}"]`);
		row!.dispatchEvent(
			new PointerEvent('pointerdown', {
				bubbles: true,
				button: 0,
				isPrimary: true,
				clientX: 10,
				clientY: 10
			})
		);
		window.dispatchEvent(
			new PointerEvent('pointermove', { bubbles: true, clientX: 30, clientY: 10 })
		);
		flushSync();
		// Placing a temp id in the view would persist a ref to an artifact that
		// does not exist and, once the commit re-keys it, never will.
		expect(isDragActive()).toBe(false);
		expect(getDragPayload()).toBeNull();
	});
});
