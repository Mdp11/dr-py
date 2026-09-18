import { describe, expect, it } from 'vitest';
import { needsExactParse, parseExact, parseLines, PyFloat } from '../../src/index.ts';

describe('needsExactParse', () => {
	it('flags floats, big integers and bare constants in value position', () => {
		for (const text of [
			'{"a":1.5}',
			'[1e5]',
			'{"a":12345678901234567}',
			'[NaN]',
			'{"a":-Infinity}',
			'2.5'
		]) {
			expect(needsExactParse(text), text).toBe(true);
		}
	});

	it('leaves plain documents to the native parser', () => {
		for (const text of [
			'{"a":1}',
			'{"v":"v2.1.1"}',
			'{"mail":"contact1@org1.example"}',
			'[1,2,3]'
		]) {
			expect(needsExactParse(text), text).toBe(false);
		}
	});

	it('tolerates a false positive inside a string', () => {
		const text = '{"ratio":"1:2.5"}';
		expect(needsExactParse(text)).toBe(true);
		expect(parseExact(text)).toEqual({ ratio: '1:2.5' });
	});
});

describe('parseLines', () => {
	it('keeps line order across the native and the exact path', () => {
		const lines = ['{"n":1}', '{"f":1.0}', '{"s":"x"}', '{"big":12345678901234567890}'];
		const values = parseLines(lines);
		expect(values[0]).toEqual({ n: 1 });
		const f = (values[1] as { f: PyFloat }).f;
		expect(f).toBeInstanceOf(PyFloat);
		expect(f.value).toBe(1);
		expect(values[2]).toEqual({ s: 'x' });
		expect((values[3] as { big: bigint }).big).toBe(12345678901234567890n);
	});

	it('handles an empty batch', () => {
		expect(parseLines([])).toEqual([]);
	});

	it('refuses a line that holds more than one document', () => {
		expect(() => parseLines(['{"a":1},{"b":2}', '{"c":3}'])).toThrow(SyntaxError);
		expect(() => parseLines(['{"a":1.5},{"b":2}', '{"c":3}'])).toThrow(SyntaxError);
	});
});

describe('parseExact errors', () => {
	it('rejects malformed documents', () => {
		for (const text of ['', '{', '[1,]', '{"a"}', '"open', '01', '1 2', '"bad \\x"', 'tru']) {
			expect(() => parseExact(text), text).toThrow(SyntaxError);
		}
	});
});
