// Task 10: a lock-denied snippet tab used to leave the CodeMirror document
// typeable — only the name input and Save were disabled. This pins the fix:
// the CodeMirror host goes `inert` while denied (the console stays live,
// since it is a run/results surface, not an editing one) and the banner
// gains a "Save as copy" escape hatch (`forkSnippetDraftAsCopy`) that forks
// the draft into a brand-new SEPARATE tab, leaving the source tab's draft,
// denial state, and artifact binding untouched.
//
// Uses the real snippet-editor store (mirrors snippet-editor.test.ts's
// idiom) rather than mocking `$lib/state`: `setSnippetLockDenied` is a direct
// setter, so a denied tab needs no lease/network simulation, and
// `assertNoNameClash`'s `getArtifactHeaders()` is empty without a
// `loadArtifacts()` call, so the fork itself needs no mocking either. The
// snippet-docs fetch (`ensureSnippetDocs`) and the debounced lint
// (`lintSnippet`) both degrade silently against happy-dom's unmocked fetch —
// same as every other snippet-editor.svelte.ts test.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	ensureSnippetDraft,
	getDynamicTabs,
	getSnippetDraft,
	openArtifactTab,
	resetSnippetEditors,
	resetWorkspaceTabs,
	setSnippetLockDenied
} from '$lib/state';
import SnippetTab from '../SnippetTab.svelte';

function render(tabId: string) {
	const c = mount(SnippetTab, { target: document.body, props: { tabId } });
	flushSync();
	return c;
}

beforeEach(() => {
	resetSnippetEditors();
	resetWorkspaceTabs();
});
afterEach(() => {
	resetSnippetEditors();
	resetWorkspaceTabs();
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

describe('SnippetTab lock-denied', () => {
	it('renders the CodeMirror host inert while denied, leaving the console live', async () => {
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		setSnippetLockDenied(tabId, 'peer@x');

		const c = render(tabId);
		try {
			const host = document.querySelector('[data-testid="snippet-code-host"]') as HTMLElement;
			expect(host).not.toBeNull();
			expect(host.inert).toBe(true);
			// The CodeMirror document itself still mounted underneath — inert
			// gates interaction, not rendering.
			expect(host.querySelector('[data-testid="snippet-editor"]')).not.toBeNull();
		} finally {
			unmount(c);
		}
	});

	it('is not inert once the tab is no longer denied', async () => {
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);

		const c = render(tabId);
		try {
			const host = document.querySelector('[data-testid="snippet-code-host"]') as HTMLElement;
			expect(host.inert).toBe(false);
		} finally {
			unmount(c);
		}
	});

	it('the banner offers Save as copy, which forks into a new tab and leaves the source denied', async () => {
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		setSnippetLockDenied(tabId, 'peer@x');
		vi.spyOn(window, 'prompt').mockReturnValue('Fork of snippet');

		const c = render(tabId);
		try {
			const btn = document.querySelector('[data-testid="snippet-save-as-copy"]') as HTMLElement;
			expect(btn).not.toBeNull();
			btn.click();
			flushSync();
			await Promise.resolve();
			await Promise.resolve();
			flushSync();

			expect(window.prompt).toHaveBeenCalledWith('Save copy as', 'New snippet (copy)');
			const tabs = getDynamicTabs();
			const forkTab = tabs.find((t) => t.title === 'Fork of snippet');
			expect(forkTab).toBeDefined();
			expect(forkTab!.id).not.toBe(tabId);

			// The source tab is untouched: still on screen, still denied.
			expect(document.body.contains(document.querySelector('[data-testid="snippet-editor"]'))).toBe(
				true
			);
			expect(getSnippetDraft(tabId)?.artifactId).toBeNull();
		} finally {
			unmount(c);
		}
	});
});
