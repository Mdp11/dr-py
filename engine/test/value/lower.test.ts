import { expect, it } from 'vitest';
import { pyLower } from '../../src/index.ts';

it('lowers ASCII as the table path does', () => {
	expect(pyLower('ABC xyz')).toBe('abc xyz');
	expect(pyLower('ABC xyz')).toBe(pyLower('ABC xyz' + 'é').slice(0, -1));
});

it('passes a lone surrogate through', () => {
	expect(pyLower('\ud800A')).toBe('\ud800a');
	expect(pyLower('A\udc00')).toBe('a\udc00');
	expect(pyLower('\udc00Σ')).toBe('\udc00σ');
	expect(pyLower('AΣ\ud800')).toBe('aς\ud800');
});

it('keeps a code point Python does not lower although the host does', () => {
	const cp = String.fromCodePoint(0x16ea0);
	expect(pyLower(cp)).toBe(cp);
	expect(pyLower('A' + cp)).toBe('a' + cp);
});
