import { describe, expect, it } from 'vitest';
import { mergePatch } from '../apply';

// The clone-the-world `apply(baseline, ops)` recompute was deleted in Phase
// D2 (the delta-protocol store applies ops optimistically — see
// model-store.test.ts). What remains here is its merge-patch primitive, which
// the store still uses for optimistic property updates.

describe('mergePatch', () => {
	it('overwrites existing keys and adds new ones', () => {
		expect(mergePatch({ a: 1, b: 2 }, { a: 99, c: 3 })).toEqual({ a: 99, b: 2, c: 3 });
	});

	it('removes keys patched to null', () => {
		expect(mergePatch({ a: 1, b: 2 }, { a: null })).toEqual({ b: 2 });
	});

	it('keeps non-null falsy values (0, "", false) as overwrites', () => {
		expect(mergePatch({ a: 1, b: 'x', c: true }, { a: 0, b: '', c: false })).toEqual({
			a: 0,
			b: '',
			c: false
		});
	});

	it('does not mutate the base object', () => {
		const base = { a: 1, nested: { x: 1 } };
		const out = mergePatch(base, { a: 2, b: 3 });
		expect(base).toEqual({ a: 1, nested: { x: 1 } });
		expect(out).not.toBe(base);
	});

	it('returns a copy of base for an empty patch', () => {
		const base = { a: 1 };
		const out = mergePatch(base, {});
		expect(out).toEqual(base);
		expect(out).not.toBe(base);
	});

	it('replaces object values wholesale (no deep merge)', () => {
		expect(mergePatch({ nested: { a: 1, b: 2 } }, { nested: { a: 9 } })).toEqual({
			nested: { a: 9 }
		});
	});
});
