import { describe, it, expect } from 'vitest';
import { expandTabs, hasTabs, INDENT_STRING, INDENT_WIDTH } from '../indent';

describe('expandTabs', () => {
	it('leaves tab-free text identical (and returns the same string)', () => {
		const src = 'def value(elements):\n    return len(elements)\n';
		expect(expandTabs(src)).toBe(src);
	});

	it('expands a leading tab to a full indent level', () => {
		expect(expandTabs('def f():\n\treturn 1')).toBe(`def f():\n${INDENT_STRING}return 1`);
	});

	it('counts columns to the next tab stop rather than blindly inserting four', () => {
		// "  " is 2 columns, so the tab is worth 2 more — one level total, not six.
		expect(expandTabs('  \tx')).toBe('    x');
	});

	it('restarts column counting on every line', () => {
		expect(expandTabs('ab\n\tc')).toBe('ab\n    c');
	});

	it('preserves CRLF terminators', () => {
		expect(expandTabs('a\r\n\tb')).toBe('a\r\n    b');
	});

	it('expands tabs beyond leading whitespace too', () => {
		expect(expandTabs('a\tb')).toBe(`a${' '.repeat(INDENT_WIDTH - 1)}b`);
	});
});

describe('hasTabs', () => {
	it('is false for space-indented code', () => {
		expect(hasTabs('if x:\n    pass')).toBe(false);
	});

	it('is true for any tab, leading or not', () => {
		expect(hasTabs('if x:\n\tpass')).toBe(true);
		expect(hasTabs('a\tb')).toBe(true);
	});
});
