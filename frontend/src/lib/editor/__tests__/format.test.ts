import { describe, expect, it } from 'vitest';
import { lineStartOffset } from '../format';

describe('lineStartOffset', () => {
	const text = 'a\nbb\nccc\n';

	it('returns the character offset a 1-based line starts at', () => {
		expect(lineStartOffset(text, 1)).toBe(0);
		expect(lineStartOffset(text, 2)).toBe(2);
		expect(lineStartOffset(text, 3)).toBe(5);
	});

	it('clamps a line past the end to the last line start', () => {
		expect(lineStartOffset(text, 99)).toBe(9);
	});

	it('clamps a non-positive line to 0', () => {
		expect(lineStartOffset(text, 0)).toBe(0);
		expect(lineStartOffset(text, -3)).toBe(0);
	});

	it('handles an empty document', () => {
		expect(lineStartOffset('', 1)).toBe(0);
		expect(lineStartOffset('', 5)).toBe(0);
	});
});
