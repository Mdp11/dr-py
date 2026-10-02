import { describe, expect, it } from 'vitest';
import { needsExactParse, parseExact, parseLines, parseOrdered, PyFloat } from '../../src/index.ts';

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

describe('parseOrdered', () => {
	it('keeps the order of an object that holds an array-index key, as a Map', () => {
		const parsed = parseOrdered('{"b": 1, "10": {"2": 0, "1": [1.0]}, "2": 3, "a": {"x": 1}}');
		expect(parsed).toBeInstanceOf(Map);
		const map = parsed as Map<string, unknown>;
		expect([...map.keys()]).toEqual(['b', '10', '2', 'a']);
		const inner = map.get('10') as Map<string, unknown>;
		expect([...inner.keys()]).toEqual(['2', '1']);
		expect(inner.get('1')).toEqual([new PyFloat(1)]);
		// An object without one is as `parseExact` makes it.
		expect(map.get('a')).toEqual({ x: 1 });
	});

	it('takes only the keys a JS object sorts first for an index: canonical, below 2^32 - 1', () => {
		for (const key of ['0', '7', '4294967294']) {
			expect(parseOrdered(`{"z": 1, "${key}": 2}`), key).toBeInstanceOf(Map);
		}
		for (const key of ['-1', '01', '1.5', '4294967295', '1e3', ' 1', '']) {
			expect(parseOrdered(`{"z": 1, "${key}": 2}`), key).not.toBeInstanceOf(Map);
		}
	});

	it('keeps the position of a repeated key and the value of its last', () => {
		const map = parseOrdered('{"3": 1, "a": 2, "3": 4}') as Map<string, unknown>;
		expect([...map]).toEqual([
			['3', 4],
			['a', 2]
		]);
	});

	it('reads everything else as parseExact does', () => {
		const text = '[1, 1.0, 12345678901234567890, -0, NaN, "é\\u00e9", {"k": null}, {}]';
		expect(parseOrdered(text, { floatConstants: true })).toEqual(
			parseExact(text, { floatConstants: true })
		);
	});
});
