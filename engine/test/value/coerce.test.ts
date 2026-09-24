import { expect, it } from 'vitest';
import { jsStr, PyFloat, pyFloatOf, toNumber } from '../../src/index.ts';

it('renders a PyFloat(1e21) as its exact 22-digit decimal', () => {
	expect(jsStr(new PyFloat(1e21))).toHaveLength(22);
});

it('treats a missing property as NaN and null as 0', () => {
	expect(Number.isNaN(toNumber(undefined))).toBe(true);
	expect(toNumber(null)).toBe(0);
});

it('accepts an underscore between digits and refuses a doubled one', () => {
	expect(pyFloatOf('1_000')).toBe(1000);
	expect(pyFloatOf('1__0')).toBeNull();
});

it('never throws on a lone surrogate', () => {
	expect(() => pyFloatOf('\ud800')).not.toThrow();
	expect(pyFloatOf('\ud800')).toBeNull();
});
