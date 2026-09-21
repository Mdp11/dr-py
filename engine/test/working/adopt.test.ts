import { describe, expect, it } from 'vitest';
import { ModelError, OpError, verifyConsistent, type ModelOp } from '../../src/index.ts';
import { observe } from '../golden/model-steps.ts';
import { thrown } from '../golden/thrown.ts';
import { family } from '../model/fixtures.ts';
import { workingCopy } from './helpers.ts';

const rename = (id: string, name: string): ModelOp => ({
	kind: 'update_element',
	id,
	properties_patch: { name }
});

describe('adopting staged batches', () => {
	it('lands them under their ids, and the next batch is numbered past the highest', () => {
		const source = workingCopy(family());
		source.stage([rename('a', 'one')]);
		source.stage([
			{ kind: 'create_element', temp_id: 'tmp_e', type_name: 'Node', properties: { name: 'E' } }
		]);
		const wc = workingCopy(family());
		const batches = [
			{ id: 3, ops: source.staged()[0]!.ops },
			{ id: 7, ops: source.staged()[1]!.ops }
		];
		const { changes, conflicts } = wc.adoptStaged(batches);
		expect(conflicts).toEqual([]);
		expect(wc.staged()).toEqual(batches);
		expect(observe(wc.model)).toEqual(observe(source.model));
		expect(changes.elementIds.sort()).toEqual(['a', 'tmp_e']);
		expect(changes.structural).toBe(true);
		expect(wc.stage([rename('c', 'next')]).batch.id).toBe(8);
		verifyConsistent(wc.model);
	});

	it('parks a batch that no longer applies and applies the ones after it', () => {
		const wc = workingCopy(family());
		const { conflicts } = wc.adoptStaged([
			{ id: 1, ops: [rename('a', 'fine')] },
			{ id: 2, ops: [rename('ghost', 'x')] },
			{ id: 4, ops: [rename('c', 'also fine')] }
		]);
		expect(conflicts.map(({ batch, error }) => [batch.id, error.detail])).toEqual([
			[2, "No element with id 'ghost"]
		]);
		expect(conflicts[0]!.error).toBeInstanceOf(OpError);
		expect(wc.conflicts()).toEqual(conflicts);
		expect(wc.staged().map((batch) => batch.id)).toEqual([1, 4]);
		expect(wc.model.getElement('c').props).toEqual({ name: 'also fine' });
		expect(wc.stage([rename('b', 'next')]).batch.id).toBe(5);
	});

	it('is refused by a working copy that has something staged or parked', () => {
		const wc = workingCopy(family());
		wc.stage([rename('a', 'mine')]);
		const error = thrown(() => wc.adoptStaged([{ id: 9, ops: [rename('c', 'x')] }]));
		expect(error).toBeInstanceOf(ModelError);
		expect((error as ModelError).kind).toBe('value');
		expect((error as Error).message).toBe(
			'Staged batches can only be adopted by a replica that has none'
		);
		expect(wc.staged().map((batch) => batch.id)).toEqual([1]);

		const parked = workingCopy(family());
		parked.adoptStaged([{ id: 1, ops: [rename('ghost', 'x')] }]);
		expect(() => parked.adoptStaged([{ id: 2, ops: [rename('a', 'x')] }])).toThrow(ModelError);
	});

	it('moves the staged version', () => {
		const wc = workingCopy(family());
		const version = wc.stagedVersion;
		wc.adoptStaged([{ id: 1, ops: [rename('a', 'x')] }]);
		expect(wc.stagedVersion).toBeGreaterThan(version);
	});
});
