/**
 * The CodeMirror half of the indentation policy described in `indent.ts`:
 * four-space levels, Tab/Shift-Tab bound to them, and tab characters expanded
 * on paste. Kept out of the component so it can be exercised against a bare
 * `EditorState` (no DOM, no mounted view) — the Tab/Shift-Tab step size is
 * exactly the thing that regressed, so it deserves a test that doesn't depend
 * on a headless browser delivering key events.
 */
import type { Extension } from '@codemirror/state';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { indentUnit } from '@codemirror/language';
import { indentMore, indentLess } from '@codemirror/commands';
import { expandTabs, hasTabs, INDENT_STRING, INDENT_WIDTH } from './indent';

/**
 * Expand tabs in pasted text before it lands. Code copied from a terminal, a
 * wiki or another editor routinely arrives tab-indented; dropped into a
 * space-indented snippet it produces CPython's `TabError: inconsistent use of
 * tabs and spaces in indentation`, which the author then has to fix by hand on
 * whitespace they cannot see.
 *
 * Extension handlers run BEFORE CodeMirror's built-in paste handling and
 * short-circuit it when they return true — so this deliberately bails out
 * (`false`) unless the clipboard actually contains a tab, leaving the built-in
 * line-wise-paste behaviour intact for every ordinary paste.
 */
const tabNormalizer = EditorView.domEventHandlers({
	paste(event, view) {
		const text = event.clipboardData?.getData('text/plain');
		if (!text || !hasTabs(text)) return false;
		view.dispatch(view.state.replaceSelection(expandTabs(text)), {
			scrollIntoView: true,
			userEvent: 'input.paste'
		});
		return true;
	}
});

/**
 * Four spaces per level, a tab RENDERED four wide, Tab/Shift-Tab bound to one
 * level each, and paste normalization.
 *
 * CodeMirror's default indent unit is TWO spaces. With it, Shift-Tab on the
 * four-space Python everyone actually writes removed half a level and read as
 * "Shift-Tab is broken". Tab/Shift-Tab are spelled as two separate bindings
 * rather than `indentWithTab`'s `{key:'Tab', shift: indentLess}` so the
 * dedent is matched by its own key name and stays independent of the Tab
 * binding. (`basicSetup` binds neither — CodeMirror leaves Tab for focus
 * traversal by default; a code editor wants indentation, so we opt in.)
 */
export const pythonIndentation: Extension = [
	indentUnit.of(INDENT_STRING),
	EditorState.tabSize.of(INDENT_WIDTH),
	tabNormalizer,
	keymap.of([
		{ key: 'Tab', run: indentMore },
		{ key: 'Shift-Tab', run: indentLess }
	])
];
