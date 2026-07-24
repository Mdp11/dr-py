/**
 * Text helpers for the reformat transaction.
 *
 * Reformatting replaces the whole document in ONE transaction, so the new
 * cursor position has to be computed against the incoming string rather than
 * read back off `EditorState` after the fact (a second dispatch would be a
 * second entry in the undo history). Pure string math, no CodeMirror import,
 * so it unit-tests without a DOM — same rationale as `indent.ts`.
 */

/** Character offset at which the 1-based `line` starts in `text`. A line past
 * the end clamps to the last line's start; a non-positive line clamps to 0. */
export function lineStartOffset(text: string, line: number): number {
	if (line <= 1) return 0;
	let idx = 0;
	for (let i = 1; i < line; i++) {
		const nl = text.indexOf('\n', idx);
		if (nl === -1) return idx;
		idx = nl + 1;
	}
	return idx;
}
