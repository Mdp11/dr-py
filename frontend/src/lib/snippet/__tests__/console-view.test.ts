import { describe, expect, it } from 'vitest';
import { errorKindLabel, isResultStale, opSummary, tracebackLines } from '../console-view';

describe('console-view', () => {
	it('flags staleness from the flag or a moved rev', () => {
		expect(isResultStale({ stale: false, model_rev: 5 }, 5)).toBe(false);
		expect(isResultStale({ stale: true, model_rev: 5 }, 5)).toBe(true);
		expect(isResultStale({ stale: false, model_rev: 5 }, 6)).toBe(true);
	});

	it('labels every error kind, including the never-produced ones', () => {
		for (const kind of ['syntax', 'runtime', 'timeout', 'cancelled', 'memory', 'limit'] as const) {
			expect(errorKindLabel(kind)).toBeTruthy();
		}
		expect(errorKindLabel('timeout')).toMatch(/timed out/i);
	});

	it('summarizes ops compactly', () => {
		expect(
			opSummary({
				kind: 'create_element',
				temp_id: 'tmp_x',
				type_name: 'Building',
				properties: { name: 'B1' }
			})
		).toBe('create Building "B1"');
		expect(
			opSummary({ kind: 'update_element', id: 'e1', properties_patch: { name: 'N', height: 3 } })
		).toBe('update e1 (name, height)');
		expect(opSummary({ kind: 'delete_relationship', id: 'r1' })).toBe('delete relationship r1');
	});

	it('extracts snippet line refs from a traceback', () => {
		const tb =
			'Traceback (most recent call last):\n  File "<snippet>", line 3, in <module>\nKeyError: 1';
		const lines = tracebackLines(tb);
		expect(lines[1].line).toBe(3);
		expect(lines[0].line).toBeNull();
	});
});
