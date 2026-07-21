/**
 * Indentation policy for the snippet editor. Snippets are Python and Python
 * only, and the sandbox compiles them with CPython's own tokenizer — which
 * rejects a file that mixes tab- and space-indentation with `TabError:
 * inconsistent use of tabs and spaces in indentation`. The editor therefore
 * takes the one position that can never produce that error: **spaces, four of
 * them, always** — Tab/Shift-Tab move by four, and any tab character that
 * arrives from outside (a paste from a terminal, a wiki, another IDE) is
 * expanded on the way in rather than left as a landmine the author has to
 * hunt down by hand.
 *
 * Pure functions, no CodeMirror imports, so they unit-test without a DOM.
 */

/** Columns per indentation level (PEP 8). */
export const INDENT_WIDTH = 4;

/** The literal string one indentation level inserts. */
export const INDENT_STRING = ' '.repeat(INDENT_WIDTH);

/**
 * Expand every tab character to the next `width`-column tab stop, counting
 * columns from the start of each line. Column-aware rather than a blind
 * `replace(/\t/g, '    ')` so `"  \tx"` becomes four columns (a full level),
 * not six — the same rule CPython's tokenizer uses to decide what a tab was
 * "worth", which is exactly the ambiguity `TabError` is complaining about.
 *
 * Line terminators are preserved verbatim (`\r\n` survives as `\r\n`).
 */
export function expandTabs(text: string, width = INDENT_WIDTH): string {
	if (!text.includes('\t')) return text;
	let out = '';
	let col = 0;
	for (const ch of text) {
		if (ch === '\t') {
			const pad = width - (col % width);
			out += ' '.repeat(pad);
			col += pad;
		} else if (ch === '\n' || ch === '\r') {
			out += ch;
			col = 0;
		} else {
			out += ch;
			col += 1;
		}
	}
	return out;
}

/** Whether `text` contains a tab character at all — the trigger for offering
 * the manual "Fix indentation" affordance. Deliberately not "…in leading
 * whitespace": a tab anywhere in a Python source line is at best invisible
 * noise, and inside a string literal `\t` is the readable spelling. */
export function hasTabs(text: string): boolean {
	return text.includes('\t');
}
