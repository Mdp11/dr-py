// What a script batch becomes to cross `postMessage`. Structured clone keeps a
// class instance's fields and drops its class, which would turn a `PyFloat`
// into a dict; a float therefore travels as a one-element `Float64Array` (a
// type no `Value` holds, so nothing is ambiguous) and is rebuilt on arrival.
import type { ScriptBatch } from '../../engine/src/script/host.ts';
import { PyFloat, type Value } from '../../engine/src/value/types.ts';

export type WireValue =
	| null
	| boolean
	| number
	| bigint
	| string
	| Float64Array
	| WireValue[]
	| { [key: string]: WireValue };

export type WireBatch = {
	code: string;
	entry: ScriptBatch['entry'];
	console?: boolean;
	calls: { elementIds: string[]; inputs?: WireValue; doc?: WireValue }[];
};

function wire(value: Value): WireValue {
	if (value instanceof PyFloat) return new Float64Array([value.value]);
	if (Array.isArray(value)) return value.map(wire);
	if (typeof value === 'object' && value !== null) {
		// `fromEntries` defines keys: a JSON key `__proto__` stays a key.
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, wire(item)]));
	}
	return value;
}

function unwire(value: WireValue): Value {
	if (value instanceof Float64Array) return new PyFloat(value[0] ?? NaN);
	if (Array.isArray(value)) return value.map(unwire);
	if (typeof value === 'object' && value !== null) {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unwire(item)]));
	}
	return value;
}

export function batchToWire(batch: ScriptBatch): WireBatch {
	return {
		code: batch.code,
		entry: batch.entry,
		...(batch.console !== undefined && { console: batch.console }),
		calls: batch.calls.map((call) => ({
			elementIds: [...call.elementIds],
			...(call.inputs !== undefined && { inputs: wire(call.inputs) }),
			...(call.doc !== undefined && { doc: wire(call.doc) })
		}))
	};
}

export function batchFromWire(batch: WireBatch): ScriptBatch {
	return {
		code: batch.code,
		entry: batch.entry,
		...(batch.console !== undefined && { console: batch.console }),
		calls: batch.calls.map((call) => ({
			elementIds: call.elementIds,
			...(call.inputs !== undefined && { inputs: unwire(call.inputs) }),
			...(call.doc !== undefined && { doc: unwire(call.doc) })
		}))
	};
}
