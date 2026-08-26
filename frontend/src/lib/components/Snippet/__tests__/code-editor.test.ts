// Regression coverage for the Mod-Enter -> onRun wiring in CodeEditor.svelte.
//
// basicSetup bundles @codemirror/commands' defaultKeymap, which ALSO binds
// Mod-Enter (to insertBlankLine), and CodeMirror's keymap facet tries
// earlier-registered extension groups first. The onRun binding must win
// regardless of extensions-array order, or insertBlankLine (which always
// returns true) would consume every Mod-Enter keydown before onRun is ever
// tried, silently gaining a blank line instead of running. Wrapping the
// binding in `Prec.highest(...)` is what guarantees that.
//
// This test dispatches a REAL keydown (not a synthetic facet lookup) so it
// actually exercises CodeMirror's precedence resolution end to end.
import { flushSync, mount, unmount } from 'svelte';
import { completionStatus, startCompletion } from '@codemirror/autocomplete';
import { EditorView } from '@codemirror/view';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { server } from '../../../api/__tests__/server';
import CodeEditor from '../CodeEditor.svelte';

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
afterEach(() => {
	server.resetHandlers();
	document.body.innerHTML = '';
});
afterAll(() => server.close());

function render(code: string, onRun: () => void) {
	const onChange = vi.fn();
	const c = mount(CodeEditor, {
		target: document.body,
		props: { code, onChange, onRun }
	});
	flushSync();
	return c;
}

describe('CodeEditor — Mod-Enter', () => {
	it('a real Mod-Enter keydown invokes onRun and leaves the document unchanged', () => {
		const onRun = vi.fn();
		const code = 'def value(elements):\n    return 1\n';
		const c = render(code, onRun);
		try {
			const content = document.querySelector(
				'[data-testid="snippet-editor"] .cm-content'
			) as HTMLElement;
			expect(content).toBeTruthy();
			const view = EditorView.findFromDOM(content);
			expect(view).not.toBeNull();

			// CodeMirror's `Mod` is Ctrl on Linux (this environment) — dispatch the
			// literal key combination a user would press, on the view's own
			// contentDOM, exactly as the browser would deliver it.
			const handled = content.dispatchEvent(
				new KeyboardEvent('keydown', {
					key: 'Enter',
					ctrlKey: true,
					bubbles: true,
					cancelable: true
				})
			);
			flushSync();

			expect(onRun).toHaveBeenCalledTimes(1);
			// The sharpest possible assertion: insertBlankLine did NOT run. If
			// precedence ever regresses back to array order, this fails by
			// showing an extra blank line in the document instead of an
			// unfired spy.
			expect(view!.state.doc.toString()).toBe(code);
			// jsdom reports `defaultPrevented` as the "handled" signal for a
			// dispatched event whose listener called preventDefault (which
			// CodeMirror's keymap handler does for a handled binding).
			expect(handled).toBe(false);
		} finally {
			unmount(c);
		}
	});
});

function docText(): string {
	const content = document.querySelector(
		'[data-testid="snippet-editor"] .cm-content'
	) as HTMLElement;
	const view = EditorView.findFromDOM(content);
	if (!view) throw new Error('no view');
	return view.state.doc.toString();
}

function formatButton(): HTMLButtonElement {
	const btn = document.querySelector('[data-testid="snippet-format"]') as HTMLButtonElement;
	if (!btn) throw new Error('no format button');
	return btn;
}

function clickFormat(): void {
	formatButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/** Let the fetch promise chain resolve, then flush Svelte. */
async function settle(): Promise<void> {
	await new Promise((r) => setTimeout(r, 0));
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

describe('CodeEditor — Reformat', () => {
	it('replaces the document with the formatted code in one undo step', async () => {
		server.use(
			http.post('*/snippets/format', () =>
				HttpResponse.json({ code: 'def f(a):\n    return a + 1\n', changed: true })
			)
		);
		const c = render('def f( a ):\n  return  a+1\n', () => {});
		try {
			clickFormat();
			await settle();
			expect(docText()).toBe('def f(a):\n    return a + 1\n');

			// One transaction, so one undo restores the original.
			const view = EditorView.findFromDOM(
				document.querySelector('[data-testid="snippet-editor"] .cm-content') as HTMLElement
			)!;
			view.contentDOM.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })
			);
			flushSync();
			expect(docText()).toBe('def f( a ):\n  return  a+1\n');
		} finally {
			unmount(c);
		}
	});

	it('expands tabs before sending, so tab-indented code can be formatted', async () => {
		let sent = '';
		server.use(
			http.post('*/snippets/format', async ({ request }) => {
				sent = ((await request.json()) as { code: string }).code;
				return HttpResponse.json({ code: sent, changed: false });
			})
		);
		const c = render('def f():\n\treturn 1\n', () => {});
		try {
			clickFormat();
			await settle();
			expect(sent).toBe('def f():\n    return 1\n');
			expect(sent).not.toContain('\t');
		} finally {
			unmount(c);
		}
	});

	it('a 422 shows a message and still sanitizes the tabs locally', async () => {
		server.use(
			http.post('*/snippets/format', () =>
				HttpResponse.json({ detail: 'syntax error at line 1' }, { status: 422 })
			)
		);
		const c = render('def f(:\n\tpass\n', () => {});
		try {
			clickFormat();
			await settle();
			const err = document.querySelector('[data-testid="snippet-format-error"]');
			expect(err?.textContent).toContain('syntax error');
			// The absorbed "Fix indentation" behaviour survives a refused format.
			expect(docText()).toBe('def f(:\n    pass\n');
		} finally {
			unmount(c);
		}
	});

	it('a 503 disables the control instead of failing loudly', async () => {
		server.use(
			http.post('*/snippets/format', () =>
				HttpResponse.json({ detail: 'formatter unavailable' }, { status: 503 })
			)
		);
		const c = render('x=1\n', () => {});
		try {
			clickFormat();
			await settle();
			expect(formatButton().disabled).toBe(true);
			expect(docText()).toBe('x=1\n');
		} finally {
			unmount(c);
		}
	});
});

describe('CodeEditor — Tab accepts the open completion', () => {
	it('a Tab keydown with the completion list open inserts the top suggestion instead of indenting', async () => {
		const code = 'dr.elements("B';
		const c = mount(CodeEditor, {
			target: document.body,
			props: {
				code,
				onChange: vi.fn(),
				onRun: vi.fn(),
				vocab: { typeNames: ['Building', 'Bus'] }
			}
		});
		flushSync();
		try {
			const content = document.querySelector(
				'[data-testid="snippet-editor"] .cm-content'
			) as HTMLElement;
			const view = EditorView.findFromDOM(content)!;
			view.dispatch({ selection: { anchor: code.length } });
			startCompletion(view);
			await vi.waitFor(() => expect(completionStatus(view.state)).toBe('active'));
			// `acceptCompletion` ignores a key that lands within 75ms of the list
			// opening (CodeMirror's CompletionInteractMargin — a popup must not
			// steal a keystroke already in flight), so let that window pass.
			await new Promise((r) => setTimeout(r, 100));

			content.dispatchEvent(
				new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
			);
			flushSync();

			// Without the binding, Tab reaches the indentation keymap and the
			// document gains four spaces instead of the suggestion.
			expect(view.state.doc.toString()).toBe('dr.elements("Building');
		} finally {
			unmount(c);
		}
	});
});
