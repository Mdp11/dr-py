import { expect, it } from 'vitest';
import { LineSplitter } from '../../src/index.ts';

it('hands out a line once its LF has arrived', () => {
	const splitter = new LineSplitter();
	expect(splitter.push('ab')).toEqual([]);
	expect(splitter.pending).toBe('ab');
	expect(splitter.push('c\nd')).toEqual(['abc']);
	expect(splitter.push('')).toEqual([]);
	expect(splitter.push('\n\nxy\nz')).toEqual(['d', '', 'xy']);
	expect(splitter.pending).toBe('z');
	expect(splitter.push('\n')).toEqual(['z']);
	expect(splitter.pending).toBe('');
});

it('cuts on LF alone', () => {
	const splitter = new LineSplitter();
	const lines = splitter.push('a\u{2028}b\u{2029}c\u{85}d\u{b}e\u{c}f\rg\r\nh\n');
	expect(lines).toEqual(['a\u{2028}b\u{2029}c\u{85}d\u{b}e\u{c}f\rg\r', 'h']);
});

it('gives the same lines however the text is cut', () => {
	const text = 'first\n\nthird \u{1f600}\nlast';
	for (let size = 1; size <= text.length; size++) {
		const splitter = new LineSplitter();
		const lines: string[] = [];
		for (let at = 0; at < text.length; at += size) {
			lines.push(...splitter.push(text.slice(at, at + size)));
		}
		expect([...lines, splitter.pending], `pieces of ${size}`).toEqual(text.split('\n'));
	}
});
