import { describe, expect, it } from 'vitest';
import { dumpDefault } from '../../src/script/bridge.ts';
import type { ScriptBatch } from '../../src/script/host.ts';
import { PyFloat, type Value } from '../../src/value/types.ts';
import { batchFromWire, batchToWire } from '../../src/script/wire.ts';

function crossed(batch: ScriptBatch): ScriptBatch {
	return batchFromWire(structuredClone(batchToWire(batch)));
}

describe('a script batch crossing postMessage', () => {
	it('keeps a float a float, an int an int and a big int exact', () => {
		const inputs: Value = {
			f: new PyFloat(1),
			i: 1,
			big: 2n ** 60n,
			nested: [new PyFloat(2.5), { g: new PyFloat(-0) }],
			nothing: null
		};
		const batch: ScriptBatch = {
			code: 'def value(els): return 1',
			entry: 'value',
			calls: [{ elementIds: ['a', 'b'], inputs, doc: new PyFloat(3) }, { elementIds: [] }]
		};
		const back = crossed(batch);
		expect(back.calls[1]).toEqual({ elementIds: [] });
		expect(dumpDefault(back.calls[0]!.inputs!)).toBe(dumpDefault(inputs));
		expect(dumpDefault(back.calls[0]!.inputs!)).toContain('"f": 1.0');
		expect(back.calls[0]!.doc).toBeInstanceOf(PyFloat);
		expect(back.code).toBe(batch.code);
		expect(back.entry).toBe('value');
	});

	it('keeps a console batch a console batch, and leaves the flag absent otherwise', () => {
		const calls = [{ elementIds: [] }];
		expect(crossed({ code: '', entry: 'value', console: true, calls }).console).toBe(true);
		expect('console' in crossed({ code: '', entry: 'value', calls })).toBe(false);
	});

	it('keeps an absent input absent and an explicit null null', () => {
		const back = crossed({
			code: '',
			entry: 'step',
			calls: [{ elementIds: ['a'] }, { elementIds: ['b'], inputs: null, doc: null }]
		});
		expect('inputs' in back.calls[0]!).toBe(false);
		expect(back.calls[1]).toEqual({ elementIds: ['b'], inputs: null, doc: null });
	});

	it('does not turn a dict that looks like a float into one, nor a key __proto__ into a prototype', () => {
		const inputs = JSON.parse('{"value": 1, "__proto__": {"x": 1}}') as Value;
		const back = crossed({ code: '', entry: 'value', calls: [{ elementIds: [], inputs }] });
		const got = back.calls[0]!.inputs as Record<string, Value>;
		expect(got).not.toBeInstanceOf(PyFloat);
		expect(Object.keys(got)).toEqual(['value', '__proto__']);
		expect(Object.getPrototypeOf(got)).toBe(Object.prototype);
	});
});
