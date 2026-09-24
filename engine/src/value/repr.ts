import { pyFloatRepr } from './float-repr.ts';
import { PyFloat, type Value } from './types.ts';

// Code points `str.isprintable()` rejects, the ASCII space excepted.
const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

function hex(n: number, width: number): string {
	return n.toString(16).padStart(width, '0');
}

/** `repr(str)` as Python renders it: quote choice and escapes included. */
export function pyRepr(s: string): string {
	const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
	let out = quote;
	for (const ch of s) {
		const cp = ch.codePointAt(0)!;
		if (ch === quote || ch === '\\') out += '\\' + ch;
		else if (ch === '\n') out += '\\n';
		else if (ch === '\r') out += '\\r';
		else if (ch === '\t') out += '\\t';
		else if (ch !== ' ' && NON_PRINTABLE.test(ch)) {
			if (cp < 0x100) out += '\\x' + hex(cp, 2);
			else if (cp < 0x10000) out += '\\u' + hex(cp, 4);
			else out += '\\U' + hex(cp, 8);
		} else out += ch;
	}
	return out + quote;
}

/** `repr` of any value a model property can hold: `None`, `True`/`False`, an
 * int, a float through `pyFloatRepr`, a string through `pyRepr`, and a list
 * or dict of the same, in property order. */
export function pyReprValue(v: Value): string {
	if (v === null) return 'None';
	if (v === true) return 'True';
	if (v === false) return 'False';
	if (typeof v === 'number') return String(v);
	if (typeof v === 'bigint') return v.toString();
	if (v instanceof PyFloat) return pyFloatRepr(v.value);
	if (typeof v === 'string') return pyRepr(v);
	if (Array.isArray(v)) return '[' + v.map(pyReprValue).join(', ') + ']';
	const entries = Object.entries(v).map(([k, item]) => `${pyRepr(k)}: ${pyReprValue(item)}`);
	return '{' + entries.join(', ') + '}';
}
