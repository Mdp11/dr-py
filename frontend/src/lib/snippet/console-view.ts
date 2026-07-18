/**
 * Pure view-model helpers for SnippetConsole.svelte — staleness detection,
 * error-kind labels, op-batch summaries, and traceback line extraction. No
 * store reads here: everything is a function of its arguments so it can be
 * unit-tested without mounting a component.
 */
import type { Op } from '$lib/state/ops';
import type { SnippetRunOut } from '$lib/api/snippets';
import type { SnippetError } from '$lib/api/types';

export function isResultStale(
	result: Pick<SnippetRunOut, 'stale' | 'model_rev'>,
	currentRev: number
): boolean {
	return result.stale || result.model_rev !== currentRev;
}

/** M1 runners only produce syntax/runtime/timeout/memory; cancelled/limit are
 * declared-but-unemitted (backend M2) and still render sensibly if they ever
 * appear — the console must not switch on an incomplete union. */
export function errorKindLabel(kind: SnippetError['kind']): string {
	switch (kind) {
		case 'syntax':
			return 'Syntax error';
		case 'runtime':
			return 'Runtime error';
		case 'timeout':
			return 'Timed out';
		case 'memory':
			return 'Out of memory';
		case 'cancelled':
			return 'Cancelled';
		case 'limit':
			return 'Limit exceeded';
	}
}

export function opSummary(op: Op): string {
	switch (op.kind) {
		case 'create_element': {
			const name = op.properties['name'];
			return typeof name === 'string'
				? `create ${op.type_name} "${name}"`
				: `create ${op.type_name}`;
		}
		case 'update_element':
			return `update ${op.id} (${Object.keys(op.properties_patch).join(', ')})`;
		case 'delete_element':
			return `delete ${op.id}`;
		case 'create_relationship':
			return `connect ${op.type_name}: ${op.source_id} → ${op.target_id}`;
		case 'update_relationship':
			return `update relationship ${op.id} (${Object.keys(op.properties_patch).join(', ')})`;
		case 'delete_relationship':
			return `delete relationship ${op.id}`;
	}
}

const SNIPPET_LINE_RE = /File "<snippet>", line (\d+)/;

export function tracebackLines(tb: string): Array<{ text: string; line: number | null }> {
	return tb.split('\n').map((text) => {
		const m = SNIPPET_LINE_RE.exec(text);
		return { text, line: m ? Number(m[1]) : null };
	});
}
