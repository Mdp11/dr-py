import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import * as artifactsApi from '$lib/api/artifacts';
import { resetArtifacts, setProjectInfo } from '$lib/state';
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
});
