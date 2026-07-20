// Render tests for the shared ref/inline SnippetSource editor (Task F3),
// consumed by ScriptColumnEditor (F4) and ScriptStepRow (F6). Follows the
// repo's Svelte-5 mount/flushSync/unmount convention (see
// Table/__tests__/ColumnManager.test.ts) rather than @testing-library/svelte
// (not a project dependency). Artifact headers are seeded through the REAL
// store (`$lib/state`) by mocking the underlying API call, mirroring
// `Navigation/__tests__/combine-frame.test.ts`'s `setArtifactHeaders` helper
// — there is no direct headers setter.
import { flushSync, mount, unmount } from 'svelte';
import { EditorView } from '@codemirror/view';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from '../../../api/__tests__/server';
import * as artifactsApi from '$lib/api/artifacts';
import { getArtifactHeaders, loadArtifacts, resetArtifacts } from '$lib/state';
import type { ArtifactHeader, SnippetSource } from '$lib/api/types';
import SnippetSourceEditor from '../SnippetSourceEditor.svelte';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => resetArtifacts());
afterEach(() => {
	server.resetHandlers();
	resetArtifacts();
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});
afterAll(() => server.close());

async function setArtifactHeaders(
	items: ReadonlyArray<Omit<ArtifactHeader, 'artifact_rev'> & { artifact_rev?: number }>
): Promise<void> {
	vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({
		items: items.map((h) => ({ artifact_rev: 1, ...h }))
	});
	await loadArtifacts();
}

function render(
	snippet: SnippetSource,
	entry: 'value' | 'step',
	onChange: (next: SnippetSource) => void
) {
	const c = mount(SnippetSourceEditor, {
		target: document.body,
		props: { snippet, entry, onChange }
	});
	flushSync();
	return c;
}

function select(testid: string): HTMLSelectElement {
	return document.querySelector(`[data-testid="${testid}"]`) as HTMLSelectElement;
}

function click(el: Element | null): void {
	if (!el) throw new Error('element not found');
	el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
	flushSync();
}

function inlineSnippet(code: string): SnippetSource {
	return {
		definition: { schema_version: 1, language: 'python', code, entry_points: [] }
	};
}

describe('SnippetSourceEditor — ref mode', () => {
	it('filters the ref select by kind=code_snippet and the required entry point', async () => {
		await setArtifactHeaders([
			{
				id: 'value-snip',
				kind: 'code_snippet',
				name: 'Value snippet',
				updated_at: '2026-07-17T00:00:00Z',
				updated_by: null,
				entry_points: ['script', 'value']
			},
			{
				id: 'nav-artifact',
				kind: 'navigation',
				name: 'A navigation',
				updated_at: '2026-07-17T00:00:00Z',
				updated_by: null,
				entry_points: null
			}
		]);
		expect(getArtifactHeaders()).toHaveLength(2);

		const onChange = vi.fn();
		const cValue = render({}, 'value', onChange);
		try {
			const opts = [...select('snippet-ref-select').options].map((o) => o.value);
			expect(opts).toContain('value-snip');
			expect(opts).not.toContain('nav-artifact');
		} finally {
			unmount(cValue);
		}

		const cStep = render({}, 'step', onChange);
		try {
			const opts = [...select('snippet-ref-select').options].map((o) => o.value);
			expect(opts).not.toContain('value-snip'); // lacks a step() entry point
		} finally {
			unmount(cStep);
		}
	});

	it('picking a saved snippet emits { ref }', async () => {
		await setArtifactHeaders([
			{
				id: 'value-snip',
				kind: 'code_snippet',
				name: 'Value snippet',
				updated_at: '2026-07-17T00:00:00Z',
				updated_by: null,
				entry_points: ['value']
			}
		]);
		const onChange = vi.fn();
		const c = render({}, 'value', onChange);
		try {
			const sel = select('snippet-ref-select');
			sel.value = 'value-snip';
			sel.dispatchEvent(new Event('change', { bubbles: true }));
			flushSync();
			expect(onChange).toHaveBeenCalledWith({ ref: 'value-snip' });
		} finally {
			unmount(c);
		}
	});

	it('shows a hint (without clearing the ref) when the current ref is missing from the filtered list', async () => {
		await setArtifactHeaders([]);
		const onChange = vi.fn();
		const c = render({ ref: 'gone' }, 'value', onChange);
		try {
			expect(document.querySelector('[data-testid="snippet-ref-missing"]')?.textContent).toContain(
				'snippet not found or lacks a value() entry point'
			);
			expect(onChange).not.toHaveBeenCalled();
		} finally {
			unmount(c);
		}
	});
});

describe('SnippetSourceEditor — switching to inline', () => {
	beforeEach(() => {
		server.use(
			http.post('*/snippets/lint', () => HttpResponse.json({ diagnostics: [], entry_points: [] }))
		);
	});

	it('seeds a stub definition and emits { definition } when no ref is set', () => {
		vi.useFakeTimers();
		const onChange = vi.fn();
		const c = render({}, 'value', onChange);
		try {
			click(document.querySelector('[data-testid="snippet-mode-inline"]'));
			expect(onChange).toHaveBeenCalledTimes(1);
			const next = onChange.mock.calls[0][0] as SnippetSource;
			expect(next.definition?.code).toContain('def value(elements):');
			expect(next.ref).toBeUndefined();
		} finally {
			unmount(c);
			vi.useRealTimers();
		}
	});

	it('switching back to saved clears both ref and definition', () => {
		vi.useFakeTimers();
		const onChange = vi.fn();
		const c = render(inlineSnippet('def value(elements):\n    return 1\n'), 'value', onChange);
		try {
			click(document.querySelector('[data-testid="snippet-mode-ref"]'));
			expect(onChange).toHaveBeenCalledWith({});
		} finally {
			unmount(c);
			vi.useRealTimers();
		}
	});

	it('seeds the definition from the referenced artifact code when a ref is set', async () => {
		vi.useFakeTimers();
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue({
			id: 'value-snip',
			kind: 'code_snippet',
			name: 'Value snippet',
			artifact_rev: 1,
			updated_at: '2026-07-17T00:00:00Z',
			updated_by: null,
			entry_points: ['value'],
			payload: {
				schema_version: 1,
				language: 'python',
				code: 'def value(elements):\n    return 2\n'
			}
		});
		const onChange = vi.fn();
		const c = render({ ref: 'value-snip' }, 'value', onChange);
		try {
			click(document.querySelector('[data-testid="snippet-mode-inline"]'));
			await vi.waitFor(() => expect(onChange).toHaveBeenCalled());
			const next = onChange.mock.calls.at(-1)![0] as SnippetSource;
			expect(next.definition?.code).toContain('return 2');
		} finally {
			unmount(c);
			vi.useRealTimers();
		}
	});
});

describe('SnippetSourceEditor — inline mode', () => {
	it('typing in the editor (a real CodeMirror dispatch) emits definition patches with the updated code', () => {
		vi.useFakeTimers();
		server.use(
			http.post('*/snippets/lint', () => HttpResponse.json({ diagnostics: [], entry_points: [] }))
		);
		const onChange = vi.fn();
		const c = render(inlineSnippet('def value(elements):\n    return 1\n'), 'value', onChange);
		try {
			const content = document.querySelector(
				'[data-testid="snippet-editor"] .cm-content'
			) as HTMLElement;
			expect(content).toBeTruthy();
			const view = EditorView.findFromDOM(content);
			expect(view).not.toBeNull();
			view!.dispatch({ changes: { from: view!.state.doc.length, insert: '\n# note' } });
			flushSync();
			expect(onChange).toHaveBeenCalled();
			const next = onChange.mock.calls.at(-1)![0] as SnippetSource;
			expect(next.definition?.code).toContain('# note');
			// Non-code fields of the definition are preserved by the patch.
			expect(next.definition?.schema_version).toBe(1);
		} finally {
			unmount(c);
			vi.useRealTimers();
		}
	});

	it('shows the entry warning once lint reports entry_points lacking the required entry', async () => {
		vi.useFakeTimers();
		server.use(
			http.post('*/snippets/lint', () =>
				HttpResponse.json({ diagnostics: [], entry_points: ['script'] })
			)
		);
		const onChange = vi.fn();
		const c = render(inlineSnippet('def value(elements):\n    return 1\n'), 'value', onChange);
		try {
			await vi.advanceTimersByTimeAsync(310);
			expect(
				document.querySelector('[data-testid="snippet-entry-warning"]')?.textContent
			).toContain('define value() to use this snippet here');
		} finally {
			unmount(c);
			vi.useRealTimers();
		}
	});
});
