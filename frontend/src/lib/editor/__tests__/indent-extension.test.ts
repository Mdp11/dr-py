/**
 * Tab/Shift-Tab step size, exercised against a bare `EditorState` — no DOM, no
 * mounted view. The regression this guards is precise: with CodeMirror's
 * DEFAULT two-space indent unit, Shift-Tab on four-space Python removed half a
 * level, which reads as "Shift-Tab doesn't work".
 */
import { describe, it, expect } from 'vitest';
import { EditorState, EditorSelection, type Transaction } from '@codemirror/state';
import { indentMore, indentLess } from '@codemirror/commands';
import { pythonIndentation } from '../indent-extension';
import { INDENT_WIDTH } from '../indent';

/** Run a CodeMirror command against a state and return the resulting doc.
 * Commands take a `{state, dispatch}` — a full `EditorView` is not required. */
function apply(
	doc: string,
	cursor: number,
	command: (target: { state: EditorState; dispatch: (tr: Transaction) => void }) => boolean
): { doc: string; handled: boolean } {
	const state = EditorState.create({
		doc,
		selection: EditorSelection.single(cursor),
		extensions: [pythonIndentation]
	});
	let next = state;
	const handled = command({ state, dispatch: (tr) => (next = tr.state) });
	return { doc: next.doc.toString(), handled };
}

describe('pythonIndentation', () => {
	it('configures a four-space indent unit and tab size', () => {
		const state = EditorState.create({ extensions: [pythonIndentation] });
		expect(state.tabSize).toBe(INDENT_WIDTH);
	});

	it('Shift-Tab removes a FULL four-space level', () => {
		const { doc, handled } = apply('def f():\n    return 1', 13, indentLess);
		expect(handled).toBe(true);
		expect(doc).toBe('def f():\nreturn 1');
	});

	it('Shift-Tab on a doubly-indented line removes exactly one level', () => {
		const { doc } = apply('if x:\n    if y:\n        pass', 24, indentLess);
		expect(doc).toBe('if x:\n    if y:\n    pass');
	});

	it('Tab adds a full four-space level', () => {
		const { doc } = apply('def f():\nreturn 1', 9, indentMore);
		expect(doc).toBe('def f():\n    return 1');
	});

	it('Shift-Tab on an unindented line leaves the doc alone', () => {
		const { doc } = apply('pass', 0, indentLess);
		expect(doc).toBe('pass');
	});
});
