import { describe, expect, it } from 'vitest';
import { translatePyRegex } from '../../src/index.ts';
import { loadFixture } from '../golden/load.ts';

type Fixture = {
	cases: ({ pattern: string } & ({ subjects: unknown[] } | { error: true }))[];
	code_points: { pattern: string }[];
};

const fixture = loadFixture<Fixture>('py_regex');

// One fixture pattern or more for every construct the translator vouches for:
// answering `unsupported` for any of them fails here, whatever the golden test allows.
const REQUIRED_OK = [
	// Python-only syntax.
	'(?P<a>x)(?P=a)',
	'\\d',
	'a$',
	'x{,2}y',
	// Literals and escapes.
	'abc',
	'a\\.b',
	'\\(\\)\\[\\]\\{\\}\\|\\*\\+\\?\\^\\$\\\\',
	'\\-\\#\\ \\&\\~\\/\\"\\\'',
	'\\n',
	'\\t\\r\\f\\v',
	'\\a',
	'\\x41',
	'\\u00e9',
	'\\U0001F600',
	'\\0',
	'\\07',
	'\\012',
	'\\101',
	'é+',
	'😀{2}',
	']',
	'a{',
	'a{1,2x}',
	'a{,}',
	// The dot and the classes.
	'.',
	'(?s).',
	'\\w',
	'\\W',
	'\\D',
	'\\s',
	'\\S',
	'[\\d]',
	'[^\\d]',
	'[\\w-]',
	'[\\W\\d]',
	'[^\\W\\d_]',
	'[\\s\\S]',
	'[^\\s\\S]',
	'\\bfoo\\b',
	'\\bcaf\\b',
	'\\B',
	'é\\b',
	// Anchors.
	'^a',
	'^$',
	'(?m)^b',
	'(?m)a$',
	'(?m)^$',
	'\\Aa',
	'a\\Z',
	'a\\z',
	// Classes.
	'[a-c]',
	'[^a-c]',
	'[]a]',
	'[^]a]',
	'[a-]',
	'[a\\-z]',
	'[\\b]',
	'[\\x41-\\x43]',
	'[😀-😂]',
	'[^😀]',
	'[\\0-\\x1f]',
	'[a-b-c]',
	// Quantifiers.
	'a*',
	'a+',
	'a?b',
	'a{2}',
	'a{2,}',
	'a{1,2}',
	'a{,2}',
	'a{0}b',
	'a*?b',
	'a+?',
	'a??b',
	'a{1,2}?',
	'(?:ab)+',
	'(?:a|bc)*d',
	'(a|b)*c',
	// Groups and back-references.
	'(a)',
	'(a)\\1',
	'(a)(b)\\2\\1',
	'(?P<q>[\'\\"]).*?(?P=q)',
	'(a)(?:\\1)*',
	'(?:(a)\\1)+',
	'(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)\\10',
	// Look-arounds.
	'(?=a)a',
	'a(?!b)',
	'(?<=a)b',
	'(?<!a)b',
	'(?<=ab|cd)x',
	'(?<=\\d{3})x',
	'(?<=😀)x',
	// Leading global flags.
	'(?i)abc',
	'(?i)k',
	'(?i)\\u212a',
	'(?i)s',
	'(?i)ß',
	'(?i)i',
	'(?i)İ',
	'(?i)ı',
	'(?i)σ',
	'(?i)𐐀',
	'(?i)pipe',
	'(?i)[a-z]+',
	'(?i)[^a-z]',
	'(?i)[^k]',
	'(?i)[a\\W]',
	'(?i)a|\\W',
	'(?s)a.b',
	'(?im)^a$',
	'(?i)(?m)^b',
	'(?si)A.B',
	// Alternation.
	'cat|dog',
	'a|',
	'^(?:a|ab)$',
	'^Pump-\\d{3}$'
];

const MODES = ['search', 'fullmatch'] as const;

describe('translatePyRegex', () => {
	it('answers ok for every construct of its subset', () => {
		const refused = REQUIRED_OK.flatMap((pattern) =>
			MODES.map((mode) => [pattern, mode, translatePyRegex(pattern, mode)] as const)
		).filter(([, , translated]) => translated.kind !== 'ok');
		expect(refused).toEqual([]);
	});

	it('holds every required pattern to the fixture', () => {
		const held = new Set(fixture.cases.filter((c) => 'subjects' in c).map((c) => c.pattern));
		expect(REQUIRED_OK.filter((pattern) => !held.has(pattern))).toEqual([]);
		for (const { pattern } of fixture.code_points) {
			expect(translatePyRegex(pattern, 'fullmatch').kind).toBe('ok');
		}
	});

	it('refuses what it cannot vouch for with a reason', () => {
		for (const pattern of ['(?x)a b', 'a*+', '(?>a)', '(?i:a)', '[[a]]', '(?<=a|bc)x', 'a(?i)']) {
			const translated = translatePyRegex(pattern, 'search');
			expect(translated.kind, pattern).toBe('unsupported');
			if (translated.kind === 'unsupported') expect(translated.reason).not.toBe('');
		}
	});

	it('refuses a back-reference to a group that may not have matched', () => {
		for (const pattern of ['(a)?\\1', '(a)|\\1', '(?:(a)|b)+\\1', '(a)+\\1', '(?i)(a)\\1']) {
			expect(translatePyRegex(pattern, 'search').kind, pattern).toBe('unsupported');
		}
	});

	it('refuses a repetition count or a translation past its limits', () => {
		expect(translatePyRegex('a{4294967295}', 'search').kind).toBe('unsupported');
		expect(translatePyRegex('a{1,100000}', 'search').kind).toBe('unsupported');
		expect(translatePyRegex('\\w'.repeat(400), 'search').kind).toBe('unsupported');
	});

	it('answers invalid where re.compile refuses', () => {
		for (const pattern of ['[', '(', 'a**', '\\q', '[z-a]']) {
			expect(translatePyRegex(pattern, 'search').kind, pattern).toBe('invalid');
		}
	});

	it('memoizes per pattern and mode', () => {
		const search = translatePyRegex('memo', 'search');
		expect(translatePyRegex('memo', 'search')).toBe(search);
		expect(translatePyRegex('memo', 'fullmatch')).not.toBe(search);
	});

	it('keeps the 256 translations used last', () => {
		const patterns = Array.from({ length: 300 }, (_, n) => `bounded${n}`);
		const first = patterns.map((pattern) => translatePyRegex(pattern, 'search'));
		expect(translatePyRegex(patterns[299]!, 'search')).toBe(first[299]);
		expect(translatePyRegex(patterns[44]!, 'search')).toBe(first[44]);
		expect(translatePyRegex(patterns[43]!, 'search')).not.toBe(first[43]);
	});

	it('never throws on a lone surrogate', () => {
		for (const pattern of ['.', '\\w', '\\W', '(?i)[a-z]', '\\b', '^.$']) {
			const translated = translatePyRegex(pattern, 'fullmatch');
			expect(translated.kind).toBe('ok');
			if (translated.kind !== 'ok') continue;
			expect(() => translated.test('\ud800')).not.toThrow();
			expect(() => translated.test('a\udc00b')).not.toThrow();
		}
		const dot = translatePyRegex('.', 'fullmatch');
		expect(dot.kind === 'ok' && dot.test('\ud800')).toBe(true);
		expect(translatePyRegex('\ud800', 'search').kind).toBe('unsupported');
	});
});
