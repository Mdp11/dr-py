import { describe, expect, it } from 'vitest';
import type { MetamodelDoc } from '../../src/index.ts';
import { BridgeDispatcher, BRIDGE_LIMITS, dumpDefault } from '../../src/script/bridge.ts';
import { loadFixture } from '../golden/load.ts';
import { loadLines } from '../golden/model-load.ts';

// Behaviour `bridge.py` defines that the golden family does not pin. Every
// expectation is the oracle's own reply, taken from `BridgeDispatcher.dispatch`.

type Fixture = { metamodel: MetamodelDoc; elements: string[]; relationships: string[] };

const fixture = loadFixture<Fixture>('script_bridge');

function dispatcher(recordOps = false) {
	const model = loadLines(fixture.metamodel, fixture.elements, fixture.relationships);
	return new BridgeDispatcher(model, recordOps);
}

const page = (fields: string) => `{"id": 1, "op": "elements_page"${fields}}`;
const error = (text: string) => dumpDefault({ id: 1, error: text });

describe('int() coercion of a page request', () => {
	// A request value and the plain one the oracle reads it as.
	const same: [string, string][] = [
		['"offset": " 2 "', '"offset": 2'],
		['"offset": "1_0"', '"offset": 10'],
		['"offset": "\\u0661"', '"offset": 1'],
		['"offset": "+1"', '"offset": 1'],
		['"offset": "-1"', '"offset": 0'],
		['"offset": "\\u00a02"', '"offset": 2'],
		['"offset": "2\\u2003"', '"offset": 2'],
		['"offset": ""', '"offset": 0'],
		['"offset": {}', '"offset": 0'],
		['"offset": false', '"offset": 0'],
		['"offset": true', '"offset": 1'],
		['"offset": 1e300', '"offset": 99'],
		['"offset": -1e300', '"offset": 0'],
		['"offset": 123456789012345678901234567890', '"offset": 99'],
		['"limit": false', '"limit": 0'],
		['"limit": 0.0', '"limit": 0'],
		['"limit": 1e300', '"limit": 500'],
		['"limit": "5"', '"limit": 5'],
		['"limit": -123456789012345678901234567890', '"limit": 0']
	];
	for (const [given, plain] of same) {
		it(`${given} reads as ${plain}`, () => {
			expect(dispatcher().dispatch(page(`, ${given}`))).toBe(
				dispatcher().dispatch(page(`, ${plain}`))
			);
		});
	}

	const refused: [string, string][] = [
		['"offset": "abc"', "ValueError: invalid literal for int() with base 10: 'abc'"],
		['"offset": "1__0"', "ValueError: invalid literal for int() with base 10: '1__0'"],
		['"offset": "_1"', "ValueError: invalid literal for int() with base 10: '_1'"],
		['"offset": "0x1"', "ValueError: invalid literal for int() with base 10: '0x1'"],
		['"offset": "\\u001c2"', "ValueError: invalid literal for int() with base 10: '\\x1c2'"],
		['"limit": ""', "ValueError: invalid literal for int() with base 10: ''"],
		[
			'"offset": {"a": 1}',
			"TypeError: int() argument must be a string, a bytes-like object or a real number, not 'dict'"
		],
		['"offset": NaN', 'ValueError: cannot convert float NaN to integer'],
		['"offset": Infinity', 'OverflowError: cannot convert float infinity to integer'],
		['"limit": -Infinity', 'OverflowError: cannot convert float infinity to integer'],
		['"limit": 1e999', 'OverflowError: cannot convert float infinity to integer'],
		[
			`"offset": "${'9'.repeat(4301)}"`,
			'ValueError: Exceeds the limit (4300 digits) for integer string conversion: value has 4301 digits; ' +
				'use sys.set_int_max_str_digits() to increase the limit'
		]
	];
	for (const [given, text] of refused) {
		it(`${given.slice(0, 30)} is refused`, () => {
			expect(dispatcher().dispatch(page(`, ${given}`))).toBe(error(text));
		});
	}

	it('counts the digits of a long run without its underscores or leading zeros removed', () => {
		const run = (digits: string) => dispatcher().dispatch(page(`, "offset": "${digits}"`));
		expect(run('9'.repeat(4300))).not.toContain('error');
		expect(run('1_' + '9'.repeat(4299))).not.toContain('error');
		expect(run('0'.repeat(4300) + '1')).toContain('value has 4301 digits');
	});
});

describe('a value that is not an id or a name', () => {
	const cases: [string, string][] = [
		['{"id": 1, "op": "element", "element_id": 1.5}', "KeyError: 'No element with id 1.5'"],
		['{"id": 1, "op": "element", "element_id": true}', "KeyError: 'No element with id True'"],
		[
			'{"id": 1, "op": "element", "element_id": 1180591620717411303424}',
			"KeyError: 'No element with id 1180591620717411303424'"
		],
		['{"id": 1, "op": "element", "element_id": NaN}', "KeyError: 'No element with id nan'"],
		['{"id": 1, "op": "element", "element_id": -Infinity}', "KeyError: 'No element with id -inf'"],
		[
			'{"id": 1, "op": "descendants", "kind": "element", "name": ["x"]}',
			"TypeError: cannot use 'list' as a dict key (unhashable type: 'list')"
		],
		[
			'{"id": 1, "op": "descendants", "kind": "relationship", "name": {"x": 1}}',
			"TypeError: cannot use 'dict' as a dict key (unhashable type: 'dict')"
		],
		[
			'{"id": 1, "op": "descendants", "kind": "element", "name": 5}',
			"KeyError: 'Unknown element stereotype 5'"
		],
		[
			'{"id": 1, "op": "descendants", "kind": "element", "name": null}',
			"KeyError: 'Unknown element stereotype None'"
		],
		[
			'{"id": 1, "op": "descendants", "kind": ["e"], "name": ["x"]}',
			"ValueError: descendants: unknown kind ['e']"
		],
		[page(', "type": true'), "TypeError: 'bool' object is not iterable"],
		[page(', "type": 1.5'), "TypeError: 'float' object is not iterable"],
		[
			page(', "type": [{"a": 1}]'),
			"TypeError: cannot use 'dict' as a dict key (unhashable type: 'dict')"
		],
		[
			page(', "type": ["Node", [1]]'),
			"TypeError: cannot use 'list' as a dict key (unhashable type: 'list')"
		]
	];
	for (const [request, text] of cases) {
		it(request, () => {
			expect(dispatcher().dispatch(request)).toBe(error(text));
		});
	}

	it('a type list holding a null matches nothing', () => {
		expect(dispatcher().dispatch(page(', "type": [null]'))).toBe(
			'{"elements": [], "next_offset": null, "id": 1}'
		);
	});
});

describe('request text', () => {
	it('answers text that is not JSON with a null id', () => {
		const reply = dispatcher().dispatch('{"id": 1');
		expect(reply).toMatch(/^\{"id": null, "error": "ValueError: request is not valid JSON: /);
	});

	it('answers JSON that is not an object with a null id', () => {
		for (const text of ['[]', '5', 'null', '"x"']) {
			expect(dispatcher().dispatch(text)).toBe(
				'{"id": null, "error": "ValueError: request is not a JSON object"}'
			);
		}
	});

	it('takes the last of a repeated key, in the first one`s place', () => {
		expect(dispatcher().dispatch('{"id": 1, "op": "parent", "element_id": "n2", "id": 2}')).toBe(
			'{"parent_id": "n1", "id": 2}'
		);
	});

	it('reads NaN and Infinity as floats, and writes them back as Python does', () => {
		const recording = dispatcher(true);
		expect(recording.dispatch('{"id": 1, "op": {"a": Infinity, "temp_id": 1e400}}')).toBe(
			'{"temp_id": Infinity, "id": 1}'
		);
		expect(recording.dispatch('{"id": NaN, "op": {"temp_id": 0.0}}')).toBe(
			'{"temp_id": 0.0, "id": NaN}'
		);
		expect(recording.dispatch('{"id": 1, "op": {"temp_id": false}}')).toBe(
			'{"temp_id": false, "id": 1}'
		);
		expect(recording.dispatch('{"id": -0.0, "op": {"temp_id": null}}')).toBe('{"id": -0.0}');
	});

	it('keeps a recorded op as it arrived', () => {
		const recording = dispatcher(true);
		recording.dispatch('{"id": 1, "op": {"k": 1.0, "big": 1152921504606846977, "s": "\\u00e9"}}');
		expect(recording.ops).toHaveLength(1);
		expect(
			JSON.stringify(recording.ops[0], (_, v) => (typeof v === 'bigint' ? `${v}n` : v))
		).toContain('"1152921504606846977n"');
	});
});

describe('the limits', () => {
	it('default to the oracle`s', () => {
		expect(BRIDGE_LIMITS).toEqual({
			maxOps: 1000,
			maxOpBytes: 1048576,
			pageLimit: 500,
			maxInlineFarEndpoints: 2048
		});
	});
});
