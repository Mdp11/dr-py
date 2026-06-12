import { describe, expect, it } from 'vitest';
import type { Element, ModelOut, Relationship } from '$lib/api/types';
import { computeDiff } from '../diff';
import type { Snapshot } from '../ops';

function el(id: string, props: Record<string, unknown> = {}, rev = 1): Element {
	return { id, type_name: 'Thing', properties: props, rev };
}

function rel(
	id: string,
	source_id: string,
	target_id: string,
	props: Record<string, unknown> = {},
	rev = 1
): Relationship {
	return { id, type_name: 'Link', source_id, target_id, properties: props, rev };
}

function model(elements: Element[] = [], relationships: Relationship[] = []): ModelOut {
	return { elements, relationships };
}

function snap(elements: Element[] = [], relationships: Relationship[] = []): Snapshot {
	return { elements, relationships };
}

describe('computeDiff', () => {
	it('returns an empty diff with zero counts when nothing changed', () => {
		const baseline = model([el('e1', { a: 1 })], [rel('r1', 'e1', 'e1')]);
		const diff = computeDiff(baseline, snap([el('e1', { a: 1 })], [rel('r1', 'e1', 'e1')]));
		expect(diff.elements).toEqual([]);
		expect(diff.relationships).toEqual([]);
		expect(diff.counts).toEqual({ added: 0, modified: 0, deleted: 0 });
	});

	it('classifies a new element as added', () => {
		const baseline = model();
		const diff = computeDiff(baseline, snap([el('tmp_e1', { a: 1 }, 0)]));
		expect(diff.counts).toEqual({ added: 1, modified: 0, deleted: 0 });
		expect(diff.elements).toHaveLength(1);
		expect(diff.elements[0].status).toBe('added');
		expect(diff.elements[0].id).toBe('tmp_e1');
		expect(diff.elements[0].after?.id).toBe('tmp_e1');
		expect(diff.elements[0].before).toBeUndefined();
	});

	it('classifies a single property change as modified with that key', () => {
		const baseline = model([el('e1', { a: 1, b: 2 })]);
		const diff = computeDiff(baseline, snap([el('e1', { a: 99, b: 2 })]));
		expect(diff.counts).toEqual({ added: 0, modified: 1, deleted: 0 });
		expect(diff.elements).toHaveLength(1);
		expect(diff.elements[0].status).toBe('modified');
		expect(diff.elements[0].modifiedFields).toEqual(['a']);
	});

	it('classifies a removed key as modified with that key', () => {
		const baseline = model([el('e1', { foo: 'x', other: 1 })]);
		const diff = computeDiff(baseline, snap([el('e1', { other: 1 })]));
		expect(diff.counts.modified).toBe(1);
		expect(diff.elements[0].modifiedFields).toEqual(['foo']);
	});

	it('classifies a missing element as deleted, including its cascaded relationship', () => {
		const baseline = model([el('e1'), el('e2')], [rel('r1', 'e1', 'e2')]);
		const diff = computeDiff(baseline, snap([el('e2')]));
		expect(diff.counts).toEqual({ added: 0, modified: 0, deleted: 2 });
		const eltDeleted = diff.elements.find((d) => d.id === 'e1');
		expect(eltDeleted?.status).toBe('deleted');
		const relDeleted = diff.relationships.find((d) => d.id === 'r1');
		expect(relDeleted?.status).toBe('deleted');
	});

	it('treats update-then-update-back as unchanged (not in the diff)', () => {
		const baseline = model([el('e1', { a: 1 })]);
		const diff = computeDiff(baseline, snap([el('e1', { a: 1 })]));
		expect(diff.elements).toEqual([]);
		expect(diff.counts).toEqual({ added: 0, modified: 0, deleted: 0 });
	});

	it('classifies a new relationship as added', () => {
		const baseline = model([el('s'), el('t')]);
		const diff = computeDiff(baseline, snap([el('s'), el('t')], [rel('tmp_r', 's', 't', {}, 0)]));
		expect(diff.counts).toEqual({ added: 1, modified: 0, deleted: 0 });
		expect(diff.relationships).toHaveLength(1);
		expect(diff.relationships[0].status).toBe('added');
		expect(diff.relationships[0].id).toBe('tmp_r');
	});

	it('handles a null baseline as everything-added', () => {
		const diff = computeDiff(null, snap([el('e1', { a: 1 })]));
		expect(diff.counts).toEqual({ added: 1, modified: 0, deleted: 0 });
		expect(diff.elements[0].status).toBe('added');
	});

	it('detects deep object property differences', () => {
		const baseline = model([el('e1', { nested: { a: 1, b: [1, 2] } })]);
		const diff = computeDiff(baseline, snap([el('e1', { nested: { a: 1, b: [1, 3] } })]));
		expect(diff.counts.modified).toBe(1);
		expect(diff.elements[0].modifiedFields).toEqual(['nested']);
	});
});
