import { describe, it, expect, beforeEach } from 'vitest';
import {
	emit,
	resetModelStore,
	seedElements,
	getCachedElements,
	getStagedOpsFor,
	getStagedDepth,
	hasStagedOps,
	getStagedDiff,
	getStagedChangeCount,
	revertStagedFor,
	revertAllStaged,
	popLastStaged,
	clearStaged
} from '../index';

beforeEach(() => resetModelStore());

describe('staged buffer', () => {
	it('emit stages without flushing', () => {
		seedElements([{ id: 'e1', type_name: 'T', properties: { name: 'a' }, rev: 1 }]);
		emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'b' } });
		expect(hasStagedOps()).toBe(true);
		expect(getStagedDepth()).toBe(1);
		expect(getCachedElements().get('e1')?.properties.name).toBe('b'); // optimistic apply kept
		expect(getStagedOpsFor('e1')).toHaveLength(1);
	});

	it('getStagedDiff reflects an edit as modified', () => {
		seedElements([{ id: 'e1', type_name: 'T', properties: { name: 'a' }, rev: 1 }]);
		emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'b' } });
		const diff = getStagedDiff();
		expect(diff.counts.modified).toBe(1);
		expect(getStagedChangeCount()).toBe(1);
	});

	it('revertStagedFor reverts that element only', () => {
		seedElements([
			{ id: 'e1', type_name: 'T', properties: { name: 'a' }, rev: 1 },
			{ id: 'e2', type_name: 'T', properties: { name: 'x' }, rev: 1 }
		]);
		emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'b' } });
		emit({ kind: 'update_element', id: 'e2', properties_patch: { name: 'y' } });
		revertStagedFor('e1');
		expect(getCachedElements().get('e1')?.properties.name).toBe('a'); // reverted
		expect(getCachedElements().get('e2')?.properties.name).toBe('y'); // kept
		expect(getStagedOpsFor('e1')).toHaveLength(0);
		expect(getStagedDepth()).toBe(1);
	});

	it('popLastStaged undoes the last op only', () => {
		seedElements([{ id: 'e1', type_name: 'T', properties: { name: 'a' }, rev: 1 }]);
		emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'b' } });
		emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'c' } });
		// coalescing: both patches collapse into one queued op on e1 → undo clears it
		expect(popLastStaged()).toBe(true);
		expect(getCachedElements().get('e1')?.properties.name).toBe('a');
		expect(popLastStaged()).toBe(false); // empty
	});

	it('clearStaged drops the buffer without reverting caches', () => {
		seedElements([{ id: 'e1', type_name: 'T', properties: { name: 'a' }, rev: 1 }]);
		emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'b' } });
		clearStaged();
		expect(hasStagedOps()).toBe(false);
		expect(getCachedElements().get('e1')?.properties.name).toBe('b'); // NOT reverted
	});

	it('revertAllStaged reverts everything', () => {
		seedElements([{ id: 'e1', type_name: 'T', properties: { name: 'a' }, rev: 1 }]);
		emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'b' } });
		revertAllStaged();
		expect(hasStagedOps()).toBe(false);
		expect(getCachedElements().get('e1')?.properties.name).toBe('a');
	});
});
