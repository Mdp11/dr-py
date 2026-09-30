import { describe, expect, it } from 'vitest';
import { hostErrorResults, hostErrorText } from '../../src/script/host-error.ts';
import type { ScriptBatch } from '../../src/script/host.ts';

const batch = (entry: ScriptBatch['entry'], extra: Partial<ScriptBatch> = {}): ScriptBatch => ({
	code: '',
	entry,
	calls: [{ elementIds: ['a'] }, { elementIds: [] }],
	...extra
});

describe('a call the host failed', () => {
	it('is an embedded call’s answer, key for key, as Python writes it', () => {
		expect(hostErrorText(batch('value'), 'runtime', 'boom')).toBe(
			'{"payload": null, "error": {"kind": "runtime", "message": "boom", "traceback": null}, "reads": null, "stdout": ""}'
		);
	});

	it('is a console run’s answer for the script entry and for a console batch', () => {
		const text =
			'{"stdout": "", "result_repr": null, "truncated": false, "error": {"kind": "timeout", "message": "too slow", "traceback": null}}';
		expect(hostErrorText(batch('script'), 'timeout', 'too slow')).toBe(text);
		expect(hostErrorText(batch('value', { console: true }), 'timeout', 'too slow')).toBe(text);
	});

	it('writes every kind and escapes text as Python does', () => {
		for (const kind of ['runtime', 'timeout', 'cancelled', 'memory'] as const) {
			const answer = JSON.parse(hostErrorText(batch('step'), kind, 'é "')) as {
				error: { kind: string; message: string };
			};
			expect(answer.error).toEqual({ kind, message: 'é "', traceback: null });
		}
		expect(hostErrorText(batch('step'), 'memory', 'é😀')).toContain('"\\u00e9\\ud83d\\ude00"');
	});

	it('gives one result per call', () => {
		const results = hostErrorResults(batch('transform'), 'cancelled', 'stopped');
		expect(results).toHaveLength(2);
		expect(results[0]).toEqual(results[1]);
	});
});
