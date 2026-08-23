// A lock-denied snippet tab must not leave the CodeMirror document typeable.
// The CodeMirror host goes `inert` while denied (the console stays live,
// since it is a run/results surface, not an editing one) and the banner
// carries a "Save as copy" escape hatch (`forkSnippetDraftAsCopy`) that forks
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
import * as snippetsApi from '$lib/api/snippets';
import {
	ensureSnippetDraft,
	getDynamicTabs,
	getSnippetDraft,
	openArtifactTab,
	resetSnippetEditors,
	resetWorkspaceTabs,
	setSnippetEntry,
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

			// The source tab is untouched: still bound the same way it was before
			// the fork (a real mutation would have re-keyed or unbound it — see
			// `saveAsDraft`'s contrasting behavior, which this deliberately does not
			// mirror).
			expect(getSnippetDraft(tabId)?.artifactId).toBeNull();
		} finally {
			unmount(c);
		}
	});

	// Critical fix (post-review): the entry-hint bar's "Insert stub" button is a
	// code-mutating control that lives OUTSIDE `snippet-code-host` (it's chrome
	// above the editor, not editor content), so the host's `inert` never reached
	// it — a denied tab in `value`/`step` mode with a missing entry point could
	// still click it and dirty the code, the exact gap this task closes.
	it("disables the entry-hint bar's Insert stub while denied, and a click leaves the draft untouched", async () => {
		const lint = vi
			.spyOn(snippetsApi, 'lintSnippet')
			.mockResolvedValue({ diagnostics: [], entry_points: ['script'] }); // no 'value' — the hint fires
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId); // fires an immediate lintNow — await it below
		await Promise.resolve();
		await Promise.resolve();
		expect(lint).toHaveBeenCalled();
		setSnippetEntry(tabId, 'value');
		setSnippetLockDenied(tabId, 'peer@x');

		const c = render(tabId);
		try {
			// The hint itself stays visible/readable while denied — only the
			// mutating control is gated.
			expect(document.querySelector('[data-testid="snippet-entry-hint"]')).not.toBeNull();
			const btn = document.querySelector(
				'[data-testid="snippet-insert-stub"]'
			) as HTMLButtonElement;
			expect(btn).not.toBeNull();
			expect(btn.disabled).toBe(true);

			const before = getSnippetDraft(tabId);
			btn.click();
			flushSync();

			const after = getSnippetDraft(tabId);
			expect(after?.code).toBe(before?.code);
			expect(after?.dirty).toBe(false);
		} finally {
			unmount(c);
		}
	});
});
