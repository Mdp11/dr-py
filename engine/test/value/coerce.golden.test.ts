import { describe, expect, it } from 'vitest';
import {
	PyFloat,
	PyOverflowError,
	jsStr,
	pyFloatOf,
	toNumber,
	type Value
} from '../../src/index.ts';
import { loadFixture, untag, type Tagged } from '../golden/load.ts';
import { thrown } from '../golden/thrown.ts';

type Input = Tagged | { missing: true };
type Output = Tagged | 'nan' | { error: string };

type Fixture = {
	js_str: [Tagged, string][];
	to_number: [Input, Output][];
	float_of: [string, Tagged | null][];
};

const fixture = loadFixture<Fixture>('py_coerce');

function untagInput(input: Input): Value | undefined {
	return 'missing' in input ? undefined : untag(input);
}

function floatOf(tagged: Tagged): number {
	const value = untag(tagged);
	if (!(value instanceof PyFloat)) throw new Error('fixture float is not tagged as a float');
	return value.value;
}

describe('jsStr is str() for the criteria', () => {
	it.each(fixture.js_str)('renders %j as %j', (value, text) => {
		expect(jsStr(untag(value))).toBe(text);
	});
});

describe('toNumber is float() for the criteria', () => {
	it.each(fixture.to_number)('coerces %j to %j', (input, output) => {
		const raw = untagInput(input);
		if (typeof output === 'object' && output !== null && 'error' in output) {
			const error = thrown(() => toNumber(raw));
			expect(error).toBeInstanceOf(PyOverflowError);
			expect((error as Error).message).toBe(output.error);
			return;
		}
		const result = toNumber(raw);
		if (output === 'nan') expect(Number.isNaN(result)).toBe(true);
		else expect(Object.is(result, floatOf(output))).toBe(true);
	});
});

describe('pyFloatOf is float() for the criteria', () => {
	it.each(fixture.float_of)('parses %j as %j', (text, tagged) => {
		if (tagged === null) {
			expect(pyFloatOf(text)).toBeNull();
			return;
		}
		const expected = floatOf(tagged);
		const result = pyFloatOf(text);
		if (Number.isNaN(expected)) expect(Number.isNaN(result!)).toBe(true);
		else expect(Object.is(result, expected)).toBe(true);
	});
});
