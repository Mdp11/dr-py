import { describe, expect, it } from 'vitest';
import type { Element, ModelOut, Relationship } from '$lib/api/types';
import { apply } from '../apply';
import { computeDiff } from '../diff';
import type { Op } from '../ops';

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
	return { name: 'm', metamodel: 'mm', rev: 1, elements, relationships };
}

describe('computeDiff', () => {
	it('returns an empty diff with zero counts when no ops have been applied', () => {
		const baseline = model([el('e1', { a: 1 })], [rel('r1', 'e1', 'e1')]);
		const snap = apply(baseline, []);
		const diff = computeDiff(baseline, snap);
		expect(diff.elements).toEqual([]);
		expect(diff.relationships).toEqual([]);
		expect(diff.counts).toEqual({ added: 0, modified: 0, deleted: 0 });
	});

	it('classifies a create_element as added', () => {
		const baseline = model();
		const snap = apply(baseline, [
			{
				kind: 'create_element',
				temp_id: 'tmp_e1',
				type_name: 'Thing',
				properties: { a: 1 }
			}
		]);
		const diff = computeDiff(baseline, snap);
		expect(diff.counts).toEqual({ added: 1, modified: 0, deleted: 0 });
		expect(diff.elements).toHaveLength(1);
		expect(diff.elements[0].status).toBe('added');
		expect(diff.elements[0].id).toBe('tmp_e1');
		expect(diff.elements[0].after?.id).toBe('tmp_e1');
		expect(diff.elements[0].before).toBeUndefined();
	});

	it('classifies a single property update as modified with that key', () => {
		const baseline = model([el('e1', { a: 1, b: 2 })]);
		const snap = apply(baseline, [
			{ kind: 'update_element', id: 'e1', properties_patch: { a: 99 } }
		]);
		const diff = computeDiff(baseline, snap);
		expect(diff.counts).toEqual({ added: 0, modified: 1, deleted: 0 });
		expect(diff.elements).toHaveLength(1);
		expect(diff.elements[0].status).toBe('modified');
		expect(diff.elements[0].modifiedFields).toEqual(['a']);
	});

	it('classifies a removed key (patched to null) as modified with that key', () => {
		const baseline = model([el('e1', { foo: 'x', other: 1 })]);
		const snap = apply(baseline, [
			{ kind: 'update_element', id: 'e1', properties_patch: { foo: null } }
		]);
		const diff = computeDiff(baseline, snap);
		expect(diff.counts.modified).toBe(1);
		expect(diff.elements[0].modifiedFields).toEqual(['foo']);
	});

	it('classifies a delete_element as deleted, and the cascaded relationship is also deleted', () => {
		const baseline = model([el('e1'), el('e2')], [rel('r1', 'e1', 'e2')]);
		const snap = apply(baseline, [{ kind: 'delete_element', id: 'e1' }]);
		const diff = computeDiff(baseline, snap);
		expect(diff.counts).toEqual({ added: 0, modified: 0, deleted: 2 });
		const eltDeleted = diff.elements.find((d) => d.id === 'e1');
		expect(eltDeleted?.status).toBe('deleted');
		const relDeleted = diff.relationships.find((d) => d.id === 'r1');
		expect(relDeleted?.status).toBe('deleted');
	});

	it('treats update-then-update-back as unchanged (not in the diff)', () => {
		const baseline = model([el('e1', { a: 1 })]);
		const ops: Op[] = [
			{ kind: 'update_element', id: 'e1', properties_patch: { a: 2 } },
			{ kind: 'update_element', id: 'e1', properties_patch: { a: 1 } }
		];
		const snap = apply(baseline, ops);
		const diff = computeDiff(baseline, snap);
		expect(diff.elements).toEqual([]);
		expect(diff.counts).toEqual({ added: 0, modified: 0, deleted: 0 });
	});

	it('classifies a created relationship as added', () => {
		const baseline = model([el('s'), el('t')]);
		const snap = apply(baseline, [
			{
				kind: 'create_relationship',
				temp_id: 'tmp_r',
				type_name: 'Link',
				source_id: 's',
				target_id: 't',
				properties: {}
			}
		]);
		const diff = computeDiff(baseline, snap);
		expect(diff.counts).toEqual({ added: 1, modified: 0, deleted: 0 });
		expect(diff.relationships).toHaveLength(1);
		expect(diff.relationships[0].status).toBe('added');
		expect(diff.relationships[0].id).toBe('tmp_r');
	});

	it('handles a null baseline as everything-added', () => {
		const snap = {
			elements: [el('e1', { a: 1 })],
			relationships: []
		};
		const diff = computeDiff(null, snap);
		expect(diff.counts).toEqual({ added: 1, modified: 0, deleted: 0 });
		expect(diff.elements[0].status).toBe('added');
	});

	it('detects deep object property differences', () => {
		const baseline = model([el('e1', { nested: { a: 1, b: [1, 2] } })]);
		const snap = apply(baseline, [
			{
				kind: 'update_element',
				id: 'e1',
				properties_patch: { nested: { a: 1, b: [1, 3] } }
			}
		]);
		const diff = computeDiff(baseline, snap);
		expect(diff.counts.modified).toBe(1);
		expect(diff.elements[0].modifiedFields).toEqual(['nested']);
	});
});
