import { describe, expect, it } from 'vitest';
import type { Element, ModelOut, Relationship } from '$lib/api/types';
import { ApplyError, apply } from '../apply';
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
	return { elements, relationships };
}

describe('apply', () => {
	it('returns a snapshot equal to the baseline when ops is empty', () => {
		const baseline = model([el('e1', { x: 1 })], [rel('r1', 'e1', 'e1')]);
		const snap = apply(baseline, []);
		expect(snap.elements).toEqual(baseline.elements);
		expect(snap.relationships).toEqual(baseline.relationships);
	});

	it('does not mutate the baseline', () => {
		const baseline = model([el('e1', { x: 1 })]);
		const before = JSON.parse(JSON.stringify(baseline));
		apply(baseline, [{ kind: 'update_element', id: 'e1', properties_patch: { x: 9 } }]);
		expect(baseline).toEqual(before);
	});

	it('appends a created element with the given temp_id and rev=0', () => {
		const baseline = model();
		const ops: Op[] = [
			{
				kind: 'create_element',
				temp_id: 'tmp_e1',
				type_name: 'Thing',
				properties: { name: 'hello' }
			}
		];
		const snap = apply(baseline, ops);
		expect(snap.elements).toHaveLength(1);
		expect(snap.elements[0]).toEqual({
			id: 'tmp_e1',
			type_name: 'Thing',
			properties: { name: 'hello' },
			rev: 0
		});
	});

	it('update_element leaves untouched keys intact', () => {
		const baseline = model([el('e1', { a: 1, b: 2 })]);
		const snap = apply(baseline, [
			{ kind: 'update_element', id: 'e1', properties_patch: { a: 5 } }
		]);
		expect(snap.elements[0].properties).toEqual({ a: 5, b: 2 });
	});

	it('update_element adds new keys', () => {
		const baseline = model([el('e1', { a: 1 })]);
		const snap = apply(baseline, [
			{ kind: 'update_element', id: 'e1', properties_patch: { b: 7 } }
		]);
		expect(snap.elements[0].properties).toEqual({ a: 1, b: 7 });
	});

	it('update_element with null value removes the key', () => {
		const baseline = model([el('e1', { a: 1, b: 2 })]);
		const snap = apply(baseline, [
			{ kind: 'update_element', id: 'e1', properties_patch: { a: null } }
		]);
		expect(snap.elements[0].properties).toEqual({ b: 2 });
	});

	it('allows a relationship op to reference a temp id created in a prior op', () => {
		const baseline = model([el('src', {})]);
		const ops: Op[] = [
			{
				kind: 'create_element',
				temp_id: 'tmp_new',
				type_name: 'Thing',
				properties: {}
			},
			{
				kind: 'create_relationship',
				temp_id: 'tmp_r',
				type_name: 'Link',
				source_id: 'src',
				target_id: 'tmp_new',
				properties: {}
			}
		];
		const snap = apply(baseline, ops);
		expect(snap.elements.map((e) => e.id)).toContain('tmp_new');
		expect(snap.relationships).toHaveLength(1);
		expect(snap.relationships[0].target_id).toBe('tmp_new');
	});

	it('delete_element removes the element and any incoming/outgoing relationships', () => {
		const baseline = model(
			[el('e1'), el('e2'), el('e3')],
			[rel('r1', 'e1', 'e2'), rel('r2', 'e3', 'e2'), rel('r3', 'e1', 'e3')]
		);
		const snap = apply(baseline, [{ kind: 'delete_element', id: 'e2' }]);
		expect(snap.elements.map((e) => e.id)).toEqual(['e1', 'e3']);
		expect(snap.relationships.map((r) => r.id)).toEqual(['r3']);
	});

	it('delete_element on unknown id throws ApplyError', () => {
		const baseline = model([el('e1')]);
		expect(() => apply(baseline, [{ kind: 'delete_element', id: 'nope' }])).toThrow(ApplyError);
	});

	it('update_element on unknown id throws ApplyError', () => {
		const baseline = model([el('e1')]);
		expect(() =>
			apply(baseline, [{ kind: 'update_element', id: 'nope', properties_patch: {} }])
		).toThrow(ApplyError);
	});

	it('create_element with duplicate id (against baseline) throws ApplyError', () => {
		const baseline = model([el('e1')]);
		expect(() =>
			apply(baseline, [
				{
					kind: 'create_element',
					temp_id: 'e1',
					type_name: 'Thing',
					properties: {}
				}
			])
		).toThrow(ApplyError);
	});

	it('create_relationship appends with the given temp_id and rev=0', () => {
		const baseline = model([el('s'), el('t')]);
		const snap = apply(baseline, [
			{
				kind: 'create_relationship',
				temp_id: 'tmp_r',
				type_name: 'Link',
				source_id: 's',
				target_id: 't',
				properties: { weight: 3 }
			}
		]);
		expect(snap.relationships).toHaveLength(1);
		expect(snap.relationships[0]).toEqual({
			id: 'tmp_r',
			type_name: 'Link',
			source_id: 's',
			target_id: 't',
			properties: { weight: 3 },
			rev: 0
		});
	});

	it('create_relationship with duplicate id throws ApplyError', () => {
		const baseline = model([el('s'), el('t')], [rel('r1', 's', 't')]);
		expect(() =>
			apply(baseline, [
				{
					kind: 'create_relationship',
					temp_id: 'r1',
					type_name: 'Link',
					source_id: 's',
					target_id: 't',
					properties: {}
				}
			])
		).toThrow(ApplyError);
	});

	it('update_relationship patches properties; does not change source_id/target_id', () => {
		const baseline = model([el('s'), el('t')], [rel('r1', 's', 't', { w: 1 })]);
		const snap = apply(baseline, [
			{ kind: 'update_relationship', id: 'r1', properties_patch: { w: 2, k: 'v' } }
		]);
		expect(snap.relationships[0].properties).toEqual({ w: 2, k: 'v' });
		expect(snap.relationships[0].source_id).toBe('s');
		expect(snap.relationships[0].target_id).toBe('t');
	});

	it('update_relationship on unknown id throws ApplyError', () => {
		const baseline = model();
		expect(() =>
			apply(baseline, [{ kind: 'update_relationship', id: 'nope', properties_patch: {} }])
		).toThrow(ApplyError);
	});

	it('delete_relationship removes the relationship', () => {
		const baseline = model([el('s'), el('t')], [rel('r1', 's', 't')]);
		const snap = apply(baseline, [{ kind: 'delete_relationship', id: 'r1' }]);
		expect(snap.relationships).toHaveLength(0);
	});

	it('delete_relationship on unknown id throws ApplyError', () => {
		const baseline = model();
		expect(() => apply(baseline, [{ kind: 'delete_relationship', id: 'nope' }])).toThrow(
			ApplyError
		);
	});

	it('applies a sequence of ops across many entities correctly', () => {
		const baseline = model(
			[el('e1', { a: 1 }), el('e2', { a: 2 })],
			[rel('r1', 'e1', 'e2', { w: 10 })]
		);
		const ops: Op[] = [
			{
				kind: 'create_element',
				temp_id: 'tmp_e3',
				type_name: 'Thing',
				properties: { a: 3 }
			},
			{
				kind: 'update_element',
				id: 'e1',
				properties_patch: { a: 11, b: 'x' }
			},
			{
				kind: 'create_relationship',
				temp_id: 'tmp_r2',
				type_name: 'Link',
				source_id: 'e2',
				target_id: 'tmp_e3',
				properties: {}
			},
			{ kind: 'delete_element', id: 'e2' }
		];
		const snap = apply(baseline, ops);
		expect(snap.elements.map((e) => e.id).sort()).toEqual(['e1', 'tmp_e3']);
		expect(snap.elements.find((e) => e.id === 'e1')?.properties).toEqual({
			a: 11,
			b: 'x'
		});
		// Both relationships touched e2 — both should be gone after the delete cascade.
		expect(snap.relationships).toHaveLength(0);
	});
});
