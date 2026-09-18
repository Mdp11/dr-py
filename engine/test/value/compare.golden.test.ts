import { expect, it } from 'vitest';
import { cmpCodePoint } from '../../src/index.ts';
import { loadFixture } from '../golden/load.ts';

it('sorts strings as Python sorts them', () => {
	const c = loadFixture<{ input: string[]; sorted: string[] }>('string_order');
	expect([...c.input].sort(cmpCodePoint)).toEqual(c.sorted);
});
