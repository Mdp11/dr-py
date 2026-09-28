import { describe, expect, it } from 'vitest';
import {
	folderSegments,
	NAME_TOKENS,
	sanitizeStem,
	SPLIT_TOKENS,
	substitute,
	validateTokens
} from '../../src/index.ts';

describe('validateTokens', () => {
	it('answers null when every token is allowed', () => {
		expect(validateTokens('${name}-${rev}', NAME_TOKENS)).toBeNull();
		expect(validateTokens('no tokens here', NAME_TOKENS)).toBeNull();
	});

	it('lists unknown tokens sorted by code point, deduplicated', () => {
		expect(validateTokens('${nope}${name}${zzz}${nope}${a}', NAME_TOKENS)).toBe(
			'unknown template token(s): ${a}, ${nope}, ${zzz}'
		);
	});

	it('rejects a split-only token (id) outside SPLIT_TOKENS', () => {
		expect(validateTokens('${id}', NAME_TOKENS)).toBe('unknown template token(s): ${id}');
		expect(validateTokens('${id}', SPLIT_TOKENS)).toBeNull();
	});
});

describe('substitute', () => {
	it('replaces every known token and leaves an unknown one verbatim', () => {
		expect(substitute('${name}-${rev}-${nope}', { name: 'n', rev: '1' })).toBe('n-1-${nope}');
	});

	it('leaves a token missing from vars untouched, even if allowed elsewhere', () => {
		expect(substitute('${name}', {})).toBe('${name}');
	});
});

describe('sanitizeStem', () => {
	it('replaces unsafe characters and control characters with _', () => {
		expect(sanitizeStem('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
		expect(sanitizeStem('\x01ctrl\x1f')).toBe('_ctrl_');
	});

	it('cuts to 120 CODE POINTS, not UTF-16 units, for astral input', () => {
		const astral = '𝒜'.repeat(121); // each is a surrogate pair: 242 UTF-16 units
		const cut = sanitizeStem(astral);
		expect(Array.from(cut)).toHaveLength(120);
		expect(cut).toBe('𝒜'.repeat(120));
	});

	it('turns an all-dots stem into that many underscores, leaving "" as ""', () => {
		expect(sanitizeStem('...')).toBe('___');
		expect(sanitizeStem('.')).toBe('_');
		expect(sanitizeStem('')).toBe('');
	});

	it('does not touch a stem holding a non-dot character between dots', () => {
		expect(sanitizeStem('..x..')).toBe('..x..');
	});

	it('trims whitespace before and after the length cut', () => {
		expect(sanitizeStem('  lead')).toBe('lead');
		expect(sanitizeStem('trail  ')).toBe('trail');
	});
});

describe('folderSegments', () => {
	it('answers [] for an empty rendered path', () => {
		expect(folderSegments('')).toEqual([]);
	});

	it('splits on / and sanitizes each segment', () => {
		expect(folderSegments('a/b c/d:e')).toEqual(['a', 'b c', 'd_e']);
	});

	it('refuses a leading / or \\', () => {
		expect(() => folderSegments('/a')).toThrow('folder path must be relative');
		expect(() => folderSegments('\\a')).toThrow('folder path must be relative');
	});

	it('refuses an empty segment', () => {
		expect(() => folderSegments('a//b')).toThrow('folder path has an empty segment');
	});
});
