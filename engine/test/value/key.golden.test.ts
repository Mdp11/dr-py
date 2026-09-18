import { expect, it } from 'vitest';
import { pyKey } from '../../src/index.ts';
import { loadFixture, untag, type Tagged } from '../golden/load.ts';

it('groups values exactly as the uniqueness signature does', () => {
	const c = loadFixture<{ values: Tagged[]; groups: number[][] }>('frozen_groups');
	const byKey = new Map<string, number[]>();
	c.values.forEach((tagged, index) => {
		const key = pyKey(untag(tagged));
		byKey.set(key, [...(byKey.get(key) ?? []), index]);
	});
	const byFirst = (a: number[], b: number[]) => a[0]! - b[0]!;
	expect([...byKey.values()].sort(byFirst)).toEqual([...c.groups].sort(byFirst));
});
