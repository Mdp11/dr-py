import { describe, expect, it } from 'vitest';
import { translatePyRegex } from '../../src/index.ts';
import { loadFixture } from '../golden/load.ts';

type Case =
	{ pattern: string; subjects: [string, boolean, boolean][] } | { pattern: string; error: true };

type Fixture = {
	cases: Case[];
	code_points: { pattern: string; prefix: string; ranges: number[] }[];
};

const fixture = loadFixture<Fixture>('py_regex');
const MODES = ['search', 'fullmatch'] as const;

const hex = (cp: number) => 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');

describe('translatePyRegex answers as re.search and re.fullmatch', () => {
	it.each(fixture.cases.map((c) => [c.pattern, c] as const))('%j', (_, c) => {
		MODES.forEach((mode, column) => {
			const translated = translatePyRegex(c.pattern, mode);
			if (translated.kind === 'unsupported') return;
			if ('error' in c) {
				expect(translated.kind, mode).toBe('invalid');
				return;
			}
			expect(translated.kind, mode).toBe('ok');
			if (translated.kind !== 'ok') return;
			for (const [subject, ...expected] of c.subjects) {
				expect(translated.test(subject), `${mode} ${JSON.stringify(subject)}`).toBe(
					expected[column]
				);
			}
		});
	});
});

describe('translatePyRegex agrees with re.fullmatch on every code point', () => {
	it.each(fixture.code_points.map((c) => [c.pattern, c] as const))('%j', (_, c) => {
		const translated = translatePyRegex(c.pattern, 'fullmatch');
		expect(translated.kind).toBe('ok');
		if (translated.kind !== 'ok') return;
		const wrong: string[] = [];
		let next = 0;
		for (let cp = 0; cp <= 0x10ffff; cp++) {
			while (next < c.ranges.length && c.ranges[next + 1]! < cp) next += 2;
			const accepted = next < c.ranges.length && c.ranges[next]! <= cp;
			if (translated.test(c.prefix + String.fromCodePoint(cp)) !== accepted) wrong.push(hex(cp));
		}
		expect(wrong.slice(0, 20)).toEqual([]);
	});
});
