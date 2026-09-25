import { describe, expect, it } from 'vitest';
import { pyCasefold, pyLower } from '../../src/index.ts';

// [input, str.casefold(), str.lower()] as Python 3.14 (Unicode 16.0.0) gives them.
const CASES: [string, string, string][] = [
	['\u{DF}', 'ss', '\u{DF}'],
	['\u{1E9E}', 'ss', '\u{DF}'],
	['\u{3C2}', '\u{3C3}', '\u{3C2}'],
	['\u{3A3}', '\u{3C3}', '\u{3C3}'],
	['\u{3A3}\u{391}\u{3A3}', '\u{3C3}\u{3B1}\u{3C3}', '\u{3C3}\u{3B1}\u{3C2}'],
	['\u{B5}', '\u{3BC}', '\u{B5}'],
	['\u{17F}', 's', '\u{17F}'],
	['\u{13A0}', '\u{13A0}', '\u{AB70}'],
	['\u{AB70}', '\u{13A0}', '\u{AB70}'],
	['\u{130}', 'i\u{307}', 'i\u{307}'],
	['\u{FB01}', 'fi', '\u{FB01}'],
	['\u{1F0}', 'j\u{30C}', '\u{1F0}'],
	['\u{390}', '\u{3B9}\u{308}\u{301}', '\u{390}'],
	['\u{1FB3}', '\u{3B1}\u{3B9}', '\u{1FB3}'],
	['\u{1FBC}', '\u{3B1}\u{3B9}', '\u{1FB3}'],
	['\u{216B}', '\u{217B}', '\u{217B}'],
	['\u{10400}', '\u{10428}', '\u{10428}'],
	[
		'Stra\u{DF}e \u{3A3}\u{39F}\u{3A6}\u{39F}\u{3A3} \u{AB70}\u{FB01} \u{130} \u{B5}\u{17F}',
		'strasse \u{3C3}\u{3BF}\u{3C6}\u{3BF}\u{3C3} \u{13A0}fi i\u{307} \u{3BC}s',
		'stra\u{DF}e \u{3C3}\u{3BF}\u{3C6}\u{3BF}\u{3C2} \u{AB70}\u{FB01} i\u{307} \u{B5}\u{17F}'
	],
	['MiXeD ascii 123', 'mixed ascii 123', 'mixed ascii 123'],
	['', '', '']
];

describe('pyCasefold is str.casefold()', () => {
	it.each(CASES)('casefolds %j', (input, folded, lowered) => {
		expect(pyCasefold(input)).toBe(folded);
		expect(pyLower(input)).toBe(lowered);
	});

	it('has no final-sigma context', () => {
		expect(pyCasefold('A\u{3A3}')).toBe('a\u{3C3}');
		expect(pyCasefold('\u{3C3}\u{3BF}\u{3C6}\u{3BF}\u{3C2}')).toBe(
			pyCasefold('\u{3A3}\u{39F}\u{3A6}\u{39F}\u{3A3}')
		);
	});
});
