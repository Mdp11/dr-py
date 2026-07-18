import type { Text } from '@codemirror/state';
import type { Diagnostic } from '@codemirror/lint';
import type { SnippetDiagnostic } from '$lib/api/types';

/** Server lint speaks 1-based lines / 0-based cols; CM wants doc offsets.
 * Out-of-range lines (stale lint vs a shorter doc) are dropped, cols clamp
 * to the line end, and the range runs to end-of-line (a squiggle under the
 * rest of the line beats a zero-width mark). */
export function toCmDiagnostics(doc: Text, diags: SnippetDiagnostic[]): Diagnostic[] {
	return diags.flatMap((d) => {
		if (d.line < 1 || d.line > doc.lines) return [];
		const line = doc.line(d.line);
		const from = Math.min(line.from + Math.max(0, d.col), line.to);
		return [{ from, to: line.to, severity: d.severity, message: d.message }];
	});
}
