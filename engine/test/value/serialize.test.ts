import { expect, it } from 'vitest';
import { parseJson, pyDumps, PyFloat } from '../../src/index.ts';

it('refuses a non-finite float, as allow_nan=False does', () => {
	expect(() => pyDumps(new PyFloat(Infinity))).toThrow(RangeError);
	expect(() => pyDumps([new PyFloat(NaN)])).toThrow(RangeError);
});

it('round-trips an entity line byte for byte', () => {
	const line =
		'{"id":"e1","type_name":"Sensor","properties":{"ratio":0.25,"n":3,"f":5.0,' +
		'"big":12345678901234567890,"tags":["a","b"],"note":"café \\" \\\\ \\n"},"rev":4}';
	expect(pyDumps(parseJson(line))).toBe(line);
});

it('keeps insertion order of keys', () => {
	expect(pyDumps({ b: 1, a: 2 })).toBe('{"b":1,"a":2}');
});
