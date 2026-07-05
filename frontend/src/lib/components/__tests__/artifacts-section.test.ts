import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import * as api from '$lib/api/artifacts';
import { loadArtifacts, resetArtifacts, resetWorkspaceTabs, getDynamicTabs } from '$lib/state';
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
});
