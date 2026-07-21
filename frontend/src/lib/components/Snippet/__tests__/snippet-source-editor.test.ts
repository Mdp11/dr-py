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
import * as modelRead from '$lib/api/model-read';
import { getArtifactHeaders, loadArtifacts, resetArtifacts } from '$lib/state';
import type { Artifact, ArtifactHeader, SnippetSource } from '$lib/api/types';
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

/** Bind one element by driving the REAL picker inside ElementContextRow:
 * stub the search endpoint, type, let the 250 ms debounce fire, click the
 * result. Adapted from snippet-test-panel.test.ts's helper of the same name
 * — the panel exposes no test-only bind method here either. */
async function bindElement(id: string, label: string): Promise<void> {
	vi.spyOn(modelRead, 'listElementsPage').mockResolvedValue({
		items: [{ id, type_name: 'Block', properties: { name: label }, rev: 1 }],
		total: 1
	});
	const search = document.querySelector(
		'[data-testid="snippet-element-search"]'
	) as HTMLInputElement;
	if (!search) throw new Error('element search not rendered — is the panel expanded?');
	search.value = label;
	search.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
	await vi.advanceTimersByTimeAsync(300);
	flushSync();
	const option = [...document.querySelectorAll('button')].find((b) =>
		b.textContent?.includes(label)
	);
	if (!option) throw new Error(`no search result button for ${label}`);
	click(option);
}

const OK_RUN_RESULT = {
	run_id: 'r1',
	stdout: '',
	result_repr: "['Alpha']",
	ops: [],
	error: null,
	duration_ms: 3,
	model_rev: 0,
	stale: false,
	truncated: false
};

/** Capture the body of the next POST /snippets/run and answer `response`
 * (mirrors snippet-test-panel.test.ts's helper of the same name). */
function captureRun(response: Record<string, unknown> = OK_RUN_RESULT): {
	body: () => Record<string, unknown> | null;
} {
	let seen: Record<string, unknown> | null = null;
	server.use(
		http.post('*/snippets/run', async ({ request }) => {
			seen = (await request.json()) as Record<string, unknown>;
			return HttpResponse.json(response);
		})
	);
	return { body: () => seen };
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

	it('disables Run in the test panel when the selected ref is missing, even with an element bound (entryPoints must go empty, not just stay [entry])', async () => {
		// An element is bound first so `countOk` is satisfied — if this test
		// left it unbound, Run would be disabled either way and the assertion
		// would prove nothing about the `refMissing` wiring under test.
		vi.useFakeTimers();
		await setArtifactHeaders([]);
		const c = render({ ref: 'gone' }, 'value', vi.fn());
		try {
			expect(document.querySelector('[data-testid="snippet-ref-missing"]')).not.toBeNull();
			click(document.querySelector('[data-testid="snippet-test-toggle"]'));
			await bindElement('a', 'Alpha');
			const run = document.querySelector('[data-testid="snippet-test-run"]') as HTMLButtonElement;
			expect(run.disabled).toBe(true);
		} finally {
			unmount(c);
			vi.useRealTimers();
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

	it('does not clobber a newer ref pick with a stale getArtifact response (race)', async () => {
		// 'B' must be a real <option> for `sel.value = 'B'` to stick below.
		await setArtifactHeaders([
			{
				id: 'B',
				kind: 'code_snippet',
				name: 'B',
				updated_at: '2026-07-17T00:00:00Z',
				updated_by: null,
				entry_points: ['value']
			}
		]);
		// A plain mutable object (not $state) — mount() keeps a live reference
		// to it, so mutating a field in place is how this bare-mount test
		// simulates "the parent re-passed an updated snippet prop" without a
		// full parent/child reactivity round-trip.
		const snippet: SnippetSource = { ref: 'A' };
		let resolveArtifact: ((a: Artifact) => void) | undefined;
		const pending = new Promise<Artifact>((resolve) => {
			resolveArtifact = resolve;
		});
		const getArtifactSpy = vi.spyOn(artifactsApi, 'getArtifact').mockReturnValue(pending);
		const onChange = vi.fn();
		const c = mount(SnippetSourceEditor, {
			target: document.body,
			props: { snippet, entry: 'value', onChange }
		});
		flushSync();
		try {
			// Click "inline": switchToInline captures ref A and awaits
			// getArtifact('A') — it does not resolve yet.
			click(document.querySelector('[data-testid="snippet-mode-inline"]'));
			expect(getArtifactSpy).toHaveBeenCalledTimes(1);
			expect(getArtifactSpy).toHaveBeenCalledWith('A');

			// The ref select renders `disabled` while seeding, but disabled only
			// blocks native user interaction — a scripted dispatch (used here to
			// stand in for a concurrent update landing) still reaches the
			// listener, same as test 2 above.
			const sel = select('snippet-ref-select');
			sel.value = 'B';
			sel.dispatchEvent(new Event('change', { bubbles: true }));
			flushSync();
			expect(onChange).toHaveBeenCalledWith({ ref: 'B' });
			// Simulate the parent applying that pick back into the prop.
			snippet.ref = 'B';

			// The stale fetch for A now resolves.
			resolveArtifact!({
				id: 'A',
				kind: 'code_snippet',
				name: 'A',
				artifact_rev: 1,
				updated_at: '2026-07-17T00:00:00Z',
				updated_by: null,
				entry_points: ['value'],
				payload: {
					schema_version: 1,
					language: 'python',
					code: 'def value(elements):\n    return "A"\n'
				}
			});
			// Let switchToInline's continuation run to completion.
			await pending;
			await Promise.resolve();
			await Promise.resolve();

			// Only the { ref: 'B' } pick was ever emitted — the stale
			// continuation for A saw the changed ref and bailed silently.
			expect(onChange).toHaveBeenCalledTimes(1);
			expect(onChange).not.toHaveBeenCalledWith(
				expect.objectContaining({ definition: expect.anything() })
			);
		} finally {
			unmount(c);
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

describe('SnippetSourceEditor — test panel', () => {
	it('renders the test panel in ref mode', async () => {
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
		const c = render({ ref: 'value-snip' }, 'value', vi.fn());
		try {
			expect(document.querySelector('[data-testid="snippet-test-toggle"]')).not.toBeNull();
		} finally {
			unmount(c);
		}
	});

	it('renders the test panel in inline mode and enables Run once lint unlocks the entry and an element is bound', async () => {
		vi.useFakeTimers();
		server.use(
			http.post('*/snippets/lint', () =>
				HttpResponse.json({ diagnostics: [], entry_points: ['value'] })
			)
		);
		const c = render(inlineSnippet('def value(elements):\n    return 1\n'), 'value', vi.fn());
		try {
			await vi.advanceTimersByTimeAsync(310);
			click(document.querySelector('[data-testid="snippet-test-toggle"]'));
			const run = document.querySelector('[data-testid="snippet-test-run"]') as HTMLButtonElement;
			expect(run).toBeTruthy();
			expect(run.disabled).toBe(true); // no element bound yet

			// Now bind one element — the ONLY remaining false term in runDisabled
			// is countOk. If entryPoints weren't actually threaded through from
			// this editor's own lint state (inline ? entryPoints : [entry]),
			// entryOk would still be false and Run would stay disabled.
			await bindElement('a', 'Alpha');
			expect(run.disabled).toBe(false);
		} finally {
			unmount(c);
			vi.useRealTimers();
		}
	});

	it('the CodeEditor Mod-Enter binding invokes onRun, which drives a run through the panel (CodeEditor onRun -> testPanel.requestRun wiring)', async () => {
		// CodeEditor.svelte wraps its Mod-Enter binding in `Prec.highest(...)` so
		// it wins over basicSetup's defaultKeymap (which ALSO claims Mod-Enter,
		// for insertBlankLine) regardless of extensions-array order — see
		// CodeEditor.svelte for the full why. That lets this test dispatch a
		// REAL keydown on the view's contentDOM (as an actual keypress would
		// arrive) instead of reaching into the keymap facet to invoke the
		// binding directly, the way this test used to work around the bug.
		vi.useFakeTimers();
		server.use(
			http.post('*/snippets/lint', () =>
				HttpResponse.json({ diagnostics: [], entry_points: ['value'] })
			)
		);
		const captured = captureRun();
		const c = render(inlineSnippet('def value(elements):\n    return 1\n'), 'value', vi.fn());
		try {
			await vi.advanceTimersByTimeAsync(310);
			click(document.querySelector('[data-testid="snippet-test-toggle"]'));
			await bindElement('a', 'Alpha');
			expect(
				(document.querySelector('[data-testid="snippet-test-run"]') as HTMLButtonElement).disabled
			).toBe(false);

			const content = document.querySelector(
				'[data-testid="snippet-editor"] .cm-content'
			) as HTMLElement;
			const view = EditorView.findFromDOM(content);
			expect(view).not.toBeNull();

			// CodeMirror's `Mod` is Ctrl on Linux (this environment).
			content.dispatchEvent(
				new KeyboardEvent('keydown', {
					key: 'Enter',
					ctrlKey: true,
					bubbles: true,
					cancelable: true
				})
			);
			flushSync();

			await vi.waitFor(() => expect(captured.body()).not.toBeNull());
			expect(captured.body()!['entry']).toBe('value');
			expect(captured.body()!['element_ids']).toEqual(['a']);
		} finally {
			unmount(c);
			vi.useRealTimers();
		}
	});

	it('clicking a traceback frame moves the CodeMirror cursor to that line (onGoToLine -> editor.goToLine wiring)', async () => {
		vi.useFakeTimers();
		server.use(
			http.post('*/snippets/lint', () =>
				HttpResponse.json({ diagnostics: [], entry_points: ['value'] })
			),
			http.post('*/snippets/run', () =>
				HttpResponse.json({
					run_id: 'r1',
					stdout: '',
					result_repr: null,
					ops: [],
					error: {
						kind: 'runtime',
						message: 'boom',
						traceback:
							'Traceback (most recent call last):\n' +
							'  File "<snippet>", line 2, in value\n' +
							'NameError: boom'
					},
					duration_ms: 3,
					model_rev: 0,
					stale: false,
					truncated: false
				})
			)
		);
		const c = render(
			inlineSnippet('def value(elements):\n    return undefined_name\n'),
			'value',
			vi.fn()
		);
		try {
			await vi.advanceTimersByTimeAsync(310);
			click(document.querySelector('[data-testid="snippet-test-toggle"]'));
			await bindElement('a', 'Alpha');
			click(document.querySelector('[data-testid="snippet-test-run"]'));
			await vi.waitFor(() =>
				expect(document.querySelector('[data-testid="snippet-error"]')).not.toBeNull()
			);

			const showTraceback = [...document.querySelectorAll('button')].find((b) =>
				b.textContent?.includes('Show traceback')
			);
			click(showTraceback ?? null);
			const frameButton = [...document.querySelectorAll('button')].find((b) =>
				b.textContent?.includes('line 2, in value')
			);
			click(frameButton ?? null);

			const content = document.querySelector(
				'[data-testid="snippet-editor"] .cm-content'
			) as HTMLElement;
			const view = EditorView.findFromDOM(content);
			expect(view).not.toBeNull();
			const cursorLine = view!.state.doc.lineAt(view!.state.selection.main.head).number;
			expect(cursorLine).toBe(2);
		} finally {
			unmount(c);
			vi.useRealTimers();
		}
	});
});
