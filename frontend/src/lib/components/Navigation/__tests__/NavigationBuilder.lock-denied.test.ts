// A lock-denied navigation tab must not leave the whole definition canvas
// typeable. The canvas goes `inert` while denied (the results dock stays
// live, since it is a preview, not an editing surface) and the banner
// carries a "Save as copy" escape hatch that reuses `saveAsDraft` — the same
// fork the (disabled-while-locked) toolbar "Save as…" button uses.
//
// Uses the real navigation-editor store (mirrors results-dock.test.ts's
// idiom) rather than mocking `$lib/state`: `setNavLockDenied` is a direct
// setter, so a denied tab needs no lease/network simulation at all, and
// `assertNoNameClash`'s `getArtifactHeaders()` is empty without a
// `loadArtifacts()` call, so the fork itself needs no mocking either.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	ensureDraft,
	getDynamicTabs,
	openNavigationTab,
	resetArtifacts,
	resetCheckout,
	resetNavigationEditors,
	resetWorkspaceTabs,
	setNavLockDenied,
	setProjectInfo
} from '$lib/state';
import NavigationBuilder from '../NavigationBuilder.svelte';

function render(tabId: string) {
	const c = mount(NavigationBuilder, { target: document.body, props: { tabId } });
	flushSync();
	return c;
}

beforeEach(() => {
	resetNavigationEditors();
	resetWorkspaceTabs();
	resetArtifacts();
	resetCheckout();
	setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
});
afterEach(() => {
	resetNavigationEditors();
	resetWorkspaceTabs();
	resetArtifacts();
	resetCheckout();
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

describe('NavigationBuilder lock-denied', () => {
	it('renders the definition canvas inert while denied, leaving the results dock live', async () => {
		const tabId = openNavigationTab({ artifactId: null, title: 'New nav' });
		await ensureDraft(tabId);
		setNavLockDenied(tabId, 'peer@x');

		const c = render(tabId);
		try {
			const canvas = document.querySelector('[data-testid="nav-canvas"]') as HTMLElement;
			expect(canvas).not.toBeNull();
			expect(canvas.inert).toBe(true);

			const dock = document.querySelector('[data-testid="results-dock"]') as HTMLElement;
			expect(dock).not.toBeNull();
			expect(dock.inert).toBe(false);
			expect(dock.closest('[inert]')).toBeNull();
		} finally {
			unmount(c);
		}
	});

	it('is not inert once the tab is no longer denied', async () => {
		const tabId = openNavigationTab({ artifactId: null, title: 'New nav' });
		await ensureDraft(tabId);

		const c = render(tabId);
		try {
			const canvas = document.querySelector('[data-testid="nav-canvas"]') as HTMLElement;
			expect(canvas.inert).toBe(false);
		} finally {
			unmount(c);
		}
	});

	it('the banner offers Save as copy, which forks the draft via saveAsDraft into a new tab', async () => {
		const tabId = openNavigationTab({ artifactId: null, title: 'New nav' });
		await ensureDraft(tabId);
		setNavLockDenied(tabId, 'peer@x');
		vi.spyOn(window, 'prompt').mockReturnValue('Fork of nav');

		const c = render(tabId);
		try {
			const btn = document.querySelector('[data-testid="nav-save-as-copy"]') as HTMLElement;
			expect(btn).not.toBeNull();
			btn.click();
			flushSync();
			await Promise.resolve();
			await Promise.resolve();
			flushSync();

			const tabs = getDynamicTabs();
			expect(tabs.some((t) => t.title === 'Fork of nav')).toBe(true);
			// The prompt defaulted to the current name plus a "(copy)" suffix —
			// distinct copy from the ordinary toolbar Save-as prompt.
			expect(window.prompt).toHaveBeenCalledWith('Save copy as', 'New navigation (copy)');
		} finally {
			unmount(c);
		}
	});
});
