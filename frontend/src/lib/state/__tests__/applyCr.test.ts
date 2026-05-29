import { describe, expect, it } from 'vitest';
import type { Conflict, Element, ModelOut, Relationship } from '$lib/api/types';
import { applyChangeRequest } from '../applyCr';
import type { ChangeRequest } from '../cr';

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

function model(els: Element[], rels: Relationship[] = []): ModelOut {
	return { elements: els, relationships: rels };
}

function cr(ops: {
	elements?: {
		added?: Element[];
		modified?: { id: string; before: Element; after: Element }[];
		deleted?: Element[];
	};
	relationships?: {
		added?: Relationship[];
		modified?: { id: string; before: Relationship; after: Relationship }[];
		deleted?: Relationship[];
	};
}): ChangeRequest {
	return {
		format: 'datarover.cr/v1',
		createdAt: '2026-01-01T00:00:00.000Z',
		baseline: { filename: null, elementCount: 0, relationshipCount: 0 },
		ops: {
			elements: {
				added: ops.elements?.added ?? [],
				modified: ops.elements?.modified ?? [],
				deleted: ops.elements?.deleted ?? []
			},
			relationships: {
				added: ops.relationships?.added ?? [],
				modified: ops.relationships?.modified ?? [],
				deleted: ops.relationships?.deleted ?? []
			}
		}
	};
}

describe('applyChangeRequest — elements', () => {
	it('adds an element to the model', () => {
		const base = model([]);
		const newEl = el('e1', { name: 'A' });
		const result = applyChangeRequest(base, cr({ elements: { added: [newEl] } }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.model.elements).toHaveLength(1);
		expect(result.model.elements[0]).toMatchObject({ id: 'e1', type_name: 'Thing' });
	});

	it('modifies an element and increments rev', () => {
		const original = el('e1', { name: 'A' }, 3);
		const base = model([original]);
		const afterEl = el('e1', { name: 'B' }, 3);
		const result = applyChangeRequest(
			base,
			cr({ elements: { modified: [{ id: 'e1', before: original, after: afterEl }] } })
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const found = result.model.elements.find((e: Element) => e.id === 'e1')!;
		expect(found.properties).toEqual({ name: 'B' });
		expect(found.rev).toBe(4); // rev incremented from current (3)
	});

	it('deletes an element by id', () => {
		const e = el('e1', { name: 'A' }, 1);
		const base = model([e]);
		const result = applyChangeRequest(base, cr({ elements: { deleted: [e] } }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.model.elements).toHaveLength(0);
	});

	it('returns id_exists conflict when adding an element that already exists', () => {
		const e = el('e1', { name: 'A' });
		const base = model([e]);
		const result = applyChangeRequest(base, cr({ elements: { added: [e] } }));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.conflicts).toHaveLength(1);
		expect(result.conflicts[0].kind).toBe('id_exists');
		expect(result.conflicts[0].entity).toBe('element');
		expect(result.conflicts[0].id).toBe('e1');
	});

	it('returns missing conflict when modifying an element that does not exist', () => {
		const base = model([]);
		const ghost = el('e_ghost', { name: 'X' });
		const result = applyChangeRequest(
			base,
			cr({ elements: { modified: [{ id: 'e_ghost', before: ghost, after: ghost }] } })
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.conflicts[0].kind).toBe('missing');
		expect(result.conflicts[0].entity).toBe('element');
		expect(result.conflicts[0].id).toBe('e_ghost');
	});

	it('returns missing conflict when deleting an element that does not exist', () => {
		const base = model([]);
		const ghost = el('e_ghost');
		const result = applyChangeRequest(base, cr({ elements: { deleted: [ghost] } }));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.conflicts[0].kind).toBe('missing');
		expect(result.conflicts[0].id).toBe('e_ghost');
	});

	it('returns before_mismatch when modified before does not match current (wrong properties)', () => {
		const current = el('e1', { name: 'current' }, 5);
		const stale = el('e1', { name: 'stale' }, 5);
		const after = el('e1', { name: 'updated' }, 5);
		const base = model([current]);
		const result = applyChangeRequest(
			base,
			cr({ elements: { modified: [{ id: 'e1', before: stale, after }] } })
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.conflicts[0].kind).toBe('before_mismatch');
		expect(result.conflicts[0].entity).toBe('element');
		expect(result.conflicts[0].id).toBe('e1');
	});

	it('returns before_mismatch when deleted snapshot does not match current', () => {
		const current = el('e1', { name: 'current' }, 5);
		const stale = el('e1', { name: 'stale' }, 5);
		const base = model([current]);
		const result = applyChangeRequest(base, cr({ elements: { deleted: [stale] } }));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.conflicts[0].kind).toBe('before_mismatch');
	});

	it('collects all conflicts before returning (abort-all: reports both missing and before_mismatch)', () => {
		const current = el('e1', { name: 'A' }, 2);
		const staleModified = el('e1', { name: 'STALE' }, 2);
		const afterModified = el('e1', { name: 'B' }, 2);
		const base = model([current]);
		// e_gone doesn't exist → missing; e1 has wrong before → before_mismatch
		const result = applyChangeRequest(
			base,
			cr({
				elements: {
					modified: [{ id: 'e1', before: staleModified, after: afterModified }],
					deleted: [el('e_gone')]
				}
			})
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.conflicts).toHaveLength(2);
		const kinds = result.conflicts.map((c: Conflict) => c.kind);
		expect(kinds).toContain('before_mismatch');
		expect(kinds).toContain('missing');
	});

	it('ignores rev when comparing before snapshot (rev-ignored clean apply)', () => {
		// current has rev=5, but CR before has rev=99 — should still apply
		const current = el('e1', { name: 'A' }, 5);
		const beforeWithDifferentRev = el('e1', { name: 'A' }, 99);
		const afterEl = el('e1', { name: 'B' }, 99);
		const base = model([current]);
		const result = applyChangeRequest(
			base,
			cr({ elements: { modified: [{ id: 'e1', before: beforeWithDifferentRev, after: afterEl }] } })
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const found = result.model.elements.find((e: Element) => e.id === 'e1')!;
		expect(found.properties).toEqual({ name: 'B' });
	});

	it('does not mutate the input model', () => {
		const e = el('e1', { count: 1 }, 0);
		const base = model([e]);
		const originalElements = base.elements;
		const originalProps = { ...e.properties };
		const newEl = el('e2', { count: 2 });
		applyChangeRequest(base, cr({ elements: { added: [newEl] } }));
		expect(base.elements).toBe(originalElements);
		expect(base.elements).toHaveLength(1);
		expect(e.properties).toEqual(originalProps);
	});
});

describe('applyChangeRequest — relationships', () => {
	it('adds, modifies, and deletes relationships correctly', () => {
		const r1 = rel('r1', 'a', 'b', { weight: 1 }, 0);
		const r1After = rel('r1', 'a', 'b', { weight: 2 }, 0);
		const r2 = rel('r2', 'b', 'c', {}, 0);
		const base = model([], [r1, r2]);

		const newRel = rel('r3', 'a', 'c');
		const result = applyChangeRequest(
			base,
			cr({
				relationships: {
					added: [newRel],
					modified: [{ id: 'r1', before: r1, after: r1After }],
					deleted: [r2]
				}
			})
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const ids = result.model.relationships.map((r: Relationship) => r.id);
		expect(ids).toContain('r1');
		expect(ids).toContain('r3');
		expect(ids).not.toContain('r2');
		const modifiedR1 = result.model.relationships.find((r: Relationship) => r.id === 'r1')!;
		expect(modifiedR1.properties).toEqual({ weight: 2 });
		expect(modifiedR1.rev).toBe(1);
	});

	it('returns id_exists for a relationship add when id already in model', () => {
		const r = rel('r1', 'a', 'b');
		const base = model([], [r]);
		const result = applyChangeRequest(base, cr({ relationships: { added: [r] } }));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.conflicts[0].kind).toBe('id_exists');
		expect(result.conflicts[0].entity).toBe('relationship');
	});
});
