import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import * as api from '$lib/api/artifacts';
import { loadArtifacts, resetArtifacts, resetWorkspaceTabs, getDynamicTabs } from '$lib/state';
import { endDrag, getDragPayload, isDragActive } from '$lib/state/tree-drag.svelte';
import ArtifactsSection from '../Sidebar/ArtifactsSection.svelte';

const HEADER = {
	id: 'a1',
	kind: 'navigation',
	name: 'Sensors',
	artifact_rev: 1,
	updated_at: '2026-07-05T00:00:00Z',
	updated_by: null
};

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

beforeEach(async () => {
	resetArtifacts();
	resetWorkspaceTabs();
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
