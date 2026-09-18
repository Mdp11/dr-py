import { describe, expect, it } from 'vitest';
import { cmpCodePoint } from '../../src/index.ts';

describe('cmpCodePoint', () => {
	it('orders astral characters above the rest of the BMP', () => {
		expect(cmpCodePoint('\u{1F600}', '\uE000')).toBe(1);
		expect('\u{1F600}' < '\uE000').toBe(true);
	});

	it('handles a difference inside a surrogate pair', () => {
		expect(cmpCodePoint('x\u{1F600}', 'x\u{1F601}')).toBe(-1);
		expect(cmpCodePoint('\uD83Dz', '\u{1F600}')).toBe(-1);
	});

	it('orders prefixes and equal strings', () => {
		expect(cmpCodePoint('ab', 'abc')).toBe(-1);
		expect(cmpCodePoint('abc', 'ab')).toBe(1);
		expect(cmpCodePoint('abc', 'abc')).toBe(0);
	});
});
