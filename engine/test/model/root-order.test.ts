import { expect, it } from 'vitest';
import { ElementRec } from '../../src/index.ts';
import { RootOrder } from '../../src/model/root-order.ts';

const rec = (id: string) => new ElementRec(id, 'T', {}, 0, 0);
const listed = (order: RootOrder) => order.list().map((e) => [e.rootName, e.id]);

it('keeps roots sorted by name, then id, by code point', () => {
	const order = new RootOrder();
	const names: [string, string][] = [
		['b', 'x1'],
		['\u{1F600}', 'x2'],
		['\uFFFF', 'x3'],
		['a', 'x5'],
		['a', 'x4'],
		['', 'x6']
	];
	for (const [name, id] of names) order.add(rec(id), name);
	expect(listed(order)).toEqual([
		['', 'x6'],
		['a', 'x4'],
		['a', 'x5'],
		['b', 'x1'],
		['\uFFFF', 'x3'],
		['\u{1F600}', 'x2']
	]);
	expect(order.size).toBe(6);
});

it('removes by the name a root is filed under, and ignores a non-root', () => {
	const order = new RootOrder();
	const [a, b, c] = [rec('a'), rec('b'), rec('c')];
	order.add(a, 'same');
	order.add(b, 'same');
	order.remove(c);
	order.remove(a);
	expect(a.rootName).toBeNull();
	expect(listed(order)).toEqual([['same', 'b']]);
	order.remove(a);
	expect(order.size).toBe(1);
});

it('resets from records whose names are already set', () => {
	const order = new RootOrder();
	order.add(rec('old'), 'old');
	const roots = ['n2', 'n1'].map((id) => Object.assign(rec(id), { rootName: 'n' }));
	order.reset(roots);
	expect(listed(order)).toEqual([
		['n', 'n1'],
		['n', 'n2']
	]);
});
