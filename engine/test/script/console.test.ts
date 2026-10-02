import { describe, expect, it } from 'vitest';
import { consoleAnswer, gateOps, readRunSnippet } from '../../src/script/console.ts';

const refused = (params: unknown) => {
	try {
		readRunSnippet(params);
	} catch (error) {
		return error as { status: number; detail: string };
	}
	throw new Error('not refused');
};

describe('readRunSnippet', () => {
	it('reads one source, defaulting the entry to script', () => {
		expect(readRunSnippet({ code: 'x = 1' })).toEqual({
			code: 'x = 1',
			entry: 'script',
			element_ids: []
		});
		expect(readRunSnippet({ artifact_id: 'a', entry: 'step', element_ids: ['n1'] })).toEqual({
			artifact_id: 'a',
			entry: 'step',
			element_ids: ['n1']
		});
	});

	it('refuses both or neither of code and artifact_id', () => {
		expect(refused({ code: 'x', artifact_id: 'a' }).status).toBe(422);
		expect(refused({}).detail).toBe('provide exactly one of `code` / `artifact_id`');
	});

	it('refuses the wrong number of ids and inputs outside value', () => {
		expect(refused({ code: 'x', entry: 'value', element_ids: [] }).status).toBe(422);
		expect(refused({ code: 'x', entry: 'step', element_ids: ['a', 'b'] }).status).toBe(422);
		expect(refused({ code: 'x', entry: 'script', inputs: {} }).detail).toBe(
			"`inputs` is only meaningful for entry 'value'"
		);
		expect(refused({ code: 'x', entry: 'transform' }).status).toBe(422);
	});

	it('refuses an input that is no elements or scalars', () => {
		const value = { code: 'x', entry: 'value', element_ids: ['a'] };
		expect(refused({ ...value, inputs: { x: { kind: 'values', values: [] } } }).status).toBe(422);
		expect(refused({ ...value, inputs: { x: { kind: 'elements', ids: [1] } } }).status).toBe(422);
		expect(refused({ ...value, inputs: { x: { kind: 'scalars', values: 1 } } }).status).toBe(422);
		expect(refused({ ...value, inputs: { x: 3 } }).status).toBe(422);
		expect(
			readRunSnippet({ ...value, inputs: { x: { kind: 'elements' }, y: { kind: 'scalars' } } })
		).toBeDefined();
	});
});

describe('gateOps', () => {
	it('passes the model op kinds and refuses the rest', () => {
		expect(
			gateOps([
				{ kind: 'update_element', id: 'a', properties_patch: {} },
				{ kind: 'delete_relationship', id: 'r' }
			])
		).toMatchObject({
			ok: true
		});
		expect(gateOps([{ kind: 'create_artifact' }])).toMatchObject({ ok: false });
		expect(gateOps([{}])).toMatchObject({ ok: false });
	});

	it('refuses a malformed model op, as the stage would', () => {
		const missingId = gateOps([{ kind: 'update_element', properties_patch: {} }]);
		expect(missingId).toMatchObject({ ok: false });
		const wrongType = gateOps([{ kind: 'delete_element', id: 5 }]);
		expect(wrongType).toMatchObject({ ok: false });
		expect(gateOps([{ kind: 'update_element', id: 'n1', properties_patch: {} }])).toMatchObject({
			ok: true
		});
	});
});

describe('consoleAnswer', () => {
	const stamp = { rev: 3, staged: 1 };
	it('shapes the harness answer', () => {
		const text = '{"stdout": "hi", "result_repr": "1", "truncated": false}';
		expect(
			consoleAnswer(text, [{ kind: 'update_element', id: 'n1', properties_patch: {} }], 7, stamp)
		).toEqual({
			stdout: 'hi',
			result_repr: '1',
			ops: [{ kind: 'update_element', id: 'n1', properties_patch: {} }],
			error: null,
			truncated: false,
			duration_ms: 7,
			stamp
		});
	});

	it('empties the ops and answers a runtime error when the gate fails', () => {
		const text = '{"stdout": "", "result_repr": null, "truncated": false}';
		const answer = consoleAnswer(text, [{ kind: 'create_artifact' }], 1, stamp);
		expect(answer.ops).toEqual([]);
		expect(answer.error).toEqual({
			kind: 'runtime',
			message: 'the script proposed a create_artifact op, which is not a model op',
			traceback: null
		});
	});

	it('carries the harness error', () => {
		const text =
			'{"stdout": "", "result_repr": null, "truncated": false, "error": {"kind": "syntax", "message": "m", "traceback": null}}';
		expect(consoleAnswer(text, [], 1, stamp).error).toEqual({
			kind: 'syntax',
			message: 'm',
			traceback: null
		});
	});
});
