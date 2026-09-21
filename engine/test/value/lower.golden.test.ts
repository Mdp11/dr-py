import { describe, expect, it } from 'vitest';
import { pyLower, pyStrip } from '../../src/index.ts';
import { loadFixture } from '../golden/load.ts';

type Fixture = {
	unicode: string;
	lower: [number, string][];
	cased: [number, number][];
	ignorable: [number, number][];
	strings: [string, string][];
	space: number[];
	stripped: [string, string][];
};

const fixture = loadFixture<Fixture>('py_lower');

function* codePoints(): Generator<number> {
	for (let cp = 0; cp <= 0x10ffff; cp++) if (cp < 0xd800 || cp > 0xdfff) yield cp;
}

function inRanges(ranges: [number, number][]): Set<number> {
	const set = new Set<number>();
	for (const [start, end] of ranges) for (let cp = start; cp <= end; cp++) set.add(cp);
	return set;
}

const hex = (cp: number) => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');

describe(`pyLower is str.lower() of Unicode ${fixture.unicode}`, () => {
	it('lowers every code point alone', () => {
		const lowered = new Map(fixture.lower);
		const wrong: string[] = [];
		for (const cp of codePoints()) {
			const c = String.fromCodePoint(cp);
			if (pyLower(c) !== (lowered.get(cp) ?? c)) wrong.push(hex(cp));
		}
		expect(wrong).toEqual([]);
	});

	it('applies the final-sigma rule with every code point before the sigma', () => {
		const cased = inRanges(fixture.cased);
		const ignorable = inRanges(fixture.ignorable);
		const wrong: string[] = [];
		for (const cp of codePoints()) {
			const c = String.fromCodePoint(cp);
			if (pyLower(c + 'Σ').endsWith('ς') !== cased.has(cp)) wrong.push(hex(cp) + ' alone');
			const after = cased.has(cp) || ignorable.has(cp);
			if (pyLower('a' + c + 'Σ').endsWith('ς') !== after) wrong.push(hex(cp) + ' after a');
		}
		expect(wrong).toEqual([]);
	});

	it('lowers the chosen strings', () => {
		for (const [input, lowered] of fixture.strings) expect(pyLower(input)).toBe(lowered);
	});
});

describe('pyStrip is str.strip()', () => {
	it('strips exactly the code points str.isspace() accepts', () => {
		const space = new Set(fixture.space);
		const wrong: string[] = [];
		for (const cp of codePoints()) {
			const c = String.fromCodePoint(cp);
			if ((pyStrip(c + 'x' + c) === 'x') !== space.has(cp)) wrong.push(hex(cp));
		}
		expect(wrong).toEqual([]);
	});

	it('strips the chosen strings', () => {
		for (const [input, stripped] of fixture.stripped) expect(pyStrip(input)).toBe(stripped);
	});
});
