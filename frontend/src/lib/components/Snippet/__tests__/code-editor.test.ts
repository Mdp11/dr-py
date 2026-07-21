// Regression coverage for the Mod-Enter -> onRun wiring in CodeEditor.svelte.
//
// The bug: basicSetup bundles @codemirror/commands' defaultKeymap, which ALSO
// binds Mod-Enter (to insertBlankLine), and CodeMirror's keymap facet tries
// earlier-registered extension groups first. basicSetup used to sit ABOVE
// this component's own `keymap.of([...])` in the extensions array, so
// insertBlankLine (which always returns true) consumed every Mod-Enter
// keydown before the onRun binding was ever tried — onRun never fired, and
// the document silently gained a blank line instead. The fix wraps the
// binding in `Prec.highest(...)` so it wins regardless of array position.
//
// This test dispatches a REAL keydown (not a synthetic facet lookup) so it
// actually exercises CodeMirror's precedence resolution end to end.
import { flushSync, mount, unmount } from 'svelte';
import { EditorView } from '@codemirror/view';
import { describe, expect, it, vi } from 'vitest';

import CodeEditor from '../CodeEditor.svelte';

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
