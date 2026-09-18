import { cmpCodePoint } from './compare.ts';
import { pyFloatRepr } from './float-repr.ts';
import { PyFloat, type Value } from './types.ts';

function numericKey(v: boolean | number | bigint | PyFloat): string {
	if (typeof v === 'boolean') return v ? 'i1' : 'i0';
	if (typeof v === 'bigint') return 'i' + v.toString();
	if (typeof v === 'number') return 'i' + (v === 0 ? '0' : v.toString());
	const x = v.value;
	// An integral float equals the integer of the same value, -0.0 included.
	if (Number.isInteger(x)) return 'i' + BigInt(x).toString();
	return 'f' + pyFloatRepr(x);
}

/**
 * Canonical text of a value under the Python core's uniqueness signature
 * (`_frozen` in `core/model/indexes.py`): two values get the same key exactly
 * when their frozen forms are equal in Python. Numbers collapse across kinds
 * (`True == 1 == 1.0`); a dict freezes to its key-sorted pairs, so it equals
 * the list of those pairs, as it does there.
 */
export function pyKey(v: Value): string {
	if (v === null) return 'n';
	if (typeof v === 'string') return JSON.stringify(v);
	if (typeof v !== 'object' || v instanceof PyFloat) return numericKey(v);
	if (Array.isArray(v)) return '[' + v.map(pyKey).join(',') + ']';
	const pairs = Object.keys(v)
		.sort(cmpCodePoint)
		.map((key) => '[' + JSON.stringify(key) + ',' + pyKey(v[key]!) + ']');
	return '[' + pairs.join(',') + ']';
}
