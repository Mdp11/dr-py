import { describe, it, expect, beforeEach } from 'vitest';
import {
	emit,
	resetModelStore,
	seedElements,
	getCachedElements,
	getCachedRelationships,
	getStagedOpsFor,
	getStagedDepth,
	hasStagedOps,
	getStagedDiff,
	getStagedChangeCount,
	revertStagedFor,
	revertStagedForElement,
	revertAllStaged,
	popLastStaged,
	clearStaged,
	seedRelationships
} from '../index';
import { createTempId } from '../ops';

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

describe('revertStagedForElement (cascade)', () => {
	it('reverting a created element removes staged relationships referencing its temp id', () => {
		seedElements([{ id: 'e2', type_name: 'T', properties: {}, rev: 1 }]);
		const tmpEl = createTempId();
		const tmpRel = createTempId();
		emit({ kind: 'create_element', temp_id: tmpEl, type_name: 'T', properties: { name: 'A' } });
		emit({
			kind: 'create_relationship',
			temp_id: tmpRel,
			type_name: 'R',
			source_id: tmpEl,
			target_id: 'e2',
			properties: {}
		});
		revertStagedForElement(tmpEl);
		expect(hasStagedOps()).toBe(false);
		expect(getCachedElements().has(tmpEl)).toBe(false);
		expect(getCachedRelationships().has(tmpRel)).toBe(false);
		expect(getCachedElements().has('e2')).toBe(true); // untouched
	});

	it('reverting a real element reverts its update AND incident staged rel ops, keeping other edits', () => {
		seedElements([
			{ id: 'e1', type_name: 'T', properties: { name: 'a' }, rev: 1 },
			{ id: 'e2', type_name: 'T', properties: { name: 'x' }, rev: 1 }
		]);
		const tmpRel = createTempId();
		emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'b' } });
		emit({
			kind: 'create_relationship',
			temp_id: tmpRel,
			type_name: 'R',
			source_id: 'e1',
			target_id: 'e2',
			properties: {}
		});
		emit({ kind: 'update_element', id: 'e2', properties_patch: { name: 'y' } });
		revertStagedForElement('e1');
		expect(getCachedElements().get('e1')?.properties.name).toBe('a'); // reverted
		expect(getCachedRelationships().has(tmpRel)).toBe(false); // cascade
		expect(getCachedElements().get('e2')?.properties.name).toBe('y'); // e2 edit survives
		expect(getStagedDepth()).toBe(1);
	});

	it('reverting a staged delete restores the element and its cascade-deleted relationships', () => {
		seedElements([
			{ id: 'e1', type_name: 'T', properties: { name: 'a' }, rev: 1 },
			{ id: 'e2', type_name: 'T', properties: {}, rev: 1 }
		]);
		seedRelationships([
			{ id: 'r1', type_name: 'R', source_id: 'e1', target_id: 'e2', properties: {}, rev: 1 }
		]);
		emit({ kind: 'delete_element', id: 'e1' });
		expect(getCachedRelationships().has('r1')).toBe(false); // optimistic cascade
		revertStagedForElement('e1');
		expect(getCachedElements().get('e1')?.properties.name).toBe('a');
		expect(getCachedRelationships().has('r1')).toBe(true);
		expect(hasStagedOps()).toBe(false);
	});

	it('resolves endpoints of a staged delete_relationship from the journal (rel gone from cache)', () => {
		seedElements([
			{ id: 'e1', type_name: 'T', properties: {}, rev: 1 },
			{ id: 'e2', type_name: 'T', properties: {}, rev: 1 }
		]);
		seedRelationships([
			{ id: 'r1', type_name: 'R', source_id: 'e1', target_id: 'e2', properties: {}, rev: 1 }
		]);
		emit({ kind: 'delete_relationship', id: 'r1' });
		expect(getCachedRelationships().has('r1')).toBe(false);
		revertStagedForElement('e1'); // e1 is only reachable via the journal snapshot
		expect(getCachedRelationships().has('r1')).toBe(true); // restored
		expect(hasStagedOps()).toBe(false);
	});

	it('is a no-op when nothing targets the id', () => {
		seedElements([{ id: 'e1', type_name: 'T', properties: { name: 'a' }, rev: 1 }]);
		emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'b' } });
		revertStagedForElement('other');
		expect(getStagedDepth()).toBe(1);
		expect(getCachedElements().get('e1')?.properties.name).toBe('b');
	});
});
