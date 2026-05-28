import { describe, expect, it } from 'vitest';
import type { Element, Relationship } from '$lib/api/types';
import type { Snapshot } from '../ops';
import { resolveTempIds } from '../save';

function el(
	id: string,
	props: Record<string, unknown> = {},
	rev = 0,
	type_name = 'Thing'
): Element {
	return { id, type_name, properties: props, rev };
}

function rel(
	id: string,
	source_id: string,
	target_id: string,
	props: Record<string, unknown> = {},
	rev = 0,
	type_name = 'Link'
): Relationship {
	return { id, type_name, source_id, target_id, properties: props, rev };
}

function counter(): () => string {
	let i = 0;
	return () => `gen_${++i}`;
}

describe('resolveTempIds', () => {
	it('passes through unchanged when no temp ids are present', () => {
		const working: Snapshot = {
			elements: [el('e1', { a: 1 }, 3)],
			relationships: [rel('r1', 'e1', 'e1', { x: 'y' }, 2)]
		};
		const { resolved, mapping } = resolveTempIds(working, counter());
		expect(mapping).toEqual({});
		expect(resolved.elements).toEqual(working.elements);
		expect(resolved.relationships).toEqual(working.relationships);
	});

	it('rewrites a relationship endpoint that points at a new element', () => {
		const working: Snapshot = {
			elements: [el('tmp_a'), el('e1')],
			relationships: [
				rel('tmp_r', 'tmp_a', 'e1'),
				rel('r2', 'e1', 'tmp_a')
			]
		};
		const { resolved, mapping } = resolveTempIds(working, counter());
		expect(mapping['tmp_a']).toBe('gen_1');
		expect(mapping['tmp_r']).toBe('gen_2');
		expect(resolved.elements[0].id).toBe('gen_1');
		expect(resolved.elements[1].id).toBe('e1');
		expect(resolved.relationships[0]).toMatchObject({
			id: 'gen_2',
			source_id: 'gen_1',
			target_id: 'e1'
		});
		expect(resolved.relationships[1]).toMatchObject({
			id: 'r2',
			source_id: 'e1',
			target_id: 'gen_1'
		});
	});

	it('rewrites property values that match a temp id', () => {
		const working: Snapshot = {
			elements: [
				el('tmp_a'),
				el('e1', { ref: 'tmp_a', many: ['tmp_a', 'e1', 'other'], leaveMe: 42 })
			],
			relationships: []
		};
		const { resolved, mapping } = resolveTempIds(working, counter());
		const a = mapping['tmp_a'];
		expect(a).toBe('gen_1');
		expect(resolved.elements[1].properties.ref).toBe(a);
		expect(resolved.elements[1].properties.many).toEqual([a, 'e1', 'other']);
		expect(resolved.elements[1].properties.leaveMe).toBe(42);
	});

	it('is deterministic given a deterministic generateId', () => {
		const working: Snapshot = {
			elements: [el('tmp_a'), el('tmp_b')],
			relationships: [rel('tmp_r', 'tmp_a', 'tmp_b')]
		};
		const a = resolveTempIds(working, counter());
		const b = resolveTempIds(working, counter());
		expect(a.mapping).toEqual(b.mapping);
		expect(a.resolved).toEqual(b.resolved);
	});
});
