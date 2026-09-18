import { readFileSync } from 'node:fs';
import { PyFloat, type Value } from '../../src/index.ts';

/** A value as `tests/golden/tagged.py` renders it. */
export type Tagged =
	| { t: 'null' }
	| { t: 'bool'; v: boolean }
	| { t: 'int'; v: string }
	| { t: 'float'; hex: string }
	| { t: 'str'; v: string }
	| { t: 'list'; v: Tagged[] }
	| { t: 'dict'; v: [string, Tagged][] };

export function loadFixture<T>(name: string): T {
	const url = new URL(`../../fixtures/golden/${name}.json`, import.meta.url);
	return JSON.parse(readFileSync(url, 'utf-8')) as T;
}

export function doubleFromHex(hex: string): number {
	const view = new DataView(new ArrayBuffer(8));
	view.setBigUint64(0, BigInt('0x' + hex));
	return view.getFloat64(0);
}

export function untag(tagged: Tagged): Value {
	switch (tagged.t) {
		case 'null':
			return null;
		case 'bool':
		case 'str':
			return tagged.v;
		case 'int': {
			const n = Number(tagged.v);
			return Number.isSafeInteger(n) ? n : BigInt(tagged.v);
		}
		case 'float':
			return new PyFloat(doubleFromHex(tagged.hex));
		case 'list':
			return tagged.v.map(untag);
		case 'dict': {
			const out: { [key: string]: Value } = {};
			for (const [key, item] of tagged.v) {
				Object.defineProperty(out, key, {
					value: untag(item),
					writable: true,
					enumerable: true,
					configurable: true
				});
			}
			return out;
		}
	}
}

/** Structural equality that tells `1` from `1.0`, `0.0` from `-0.0`, and keeps key order. */
export function sameValue(a: Value, b: Value): boolean {
	if (a instanceof PyFloat || b instanceof PyFloat) {
		return a instanceof PyFloat && b instanceof PyFloat && Object.is(a.value, b.value);
	}
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((item, i) => sameValue(item, b[i]!));
	}
	if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
		const ka = Object.keys(a);
		const kb = Object.keys(b);
		if (ka.length !== kb.length) return false;
		return ka.every((key, i) => key === kb[i] && sameValue(a[key]!, b[key]!));
	}
	return Object.is(a, b);
}
