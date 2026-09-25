import { pyFloatRepr } from './float-repr.ts';
import { PyFloat, type Value } from './types.ts';

// What `json.dumps(ensure_ascii=False)` escapes: the quote, the backslash and
// the C0 controls. Everything else is written raw.
// eslint-disable-next-line no-control-regex
const MUST_ESCAPE = /["\\\x00-\x1f]/g;
const SHORT_ESCAPES: Record<string, string> = {
	'"': '\\"',
	'\\': '\\\\',
	'\b': '\\b',
	'\f': '\\f',
	'\n': '\\n',
	'\r': '\\r',
	'\t': '\\t'
};

function escapeChar(ch: string): string {
	return SHORT_ESCAPES[ch] ?? '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
}

function dumpString(s: string): string {
	return '"' + s.replace(MUST_ESCAPE, escapeChar) + '"';
}

function dumpScalar(
	v: null | boolean | number | bigint | string | PyFloat,
	allowNan: boolean
): string {
	if (v === null) return 'null';
	if (typeof v === 'string') return dumpString(v);
	if (typeof v === 'boolean') return v ? 'true' : 'false';
	if (v instanceof PyFloat) {
		if (!Number.isFinite(v.value)) {
			if (!allowNan) throw new RangeError('Out of range float values are not JSON compliant');
			return Number.isNaN(v.value) ? 'NaN' : v.value > 0 ? 'Infinity' : '-Infinity';
		}
		return pyFloatRepr(v.value);
	}
	return v.toString();
}

function dump(v: Value, indent: number | undefined, depth: number, allowNan: boolean): string {
	if (typeof v !== 'object' || v === null || v instanceof PyFloat) return dumpScalar(v, allowNan);
	const isArray = Array.isArray(v);
	const parts = isArray
		? v.map((item) => dump(item, indent, depth + 1, allowNan))
		: Object.entries(v).map(
				([key, item]) =>
					dumpString(key) +
					(indent === undefined ? ':' : ': ') +
					dump(item, indent, depth + 1, allowNan)
			);
	const [open, close] = isArray ? '[]' : '{}';
	if (parts.length === 0) return open! + close!;
	if (indent === undefined) return open + parts.join(',') + close;
	const inner = '\n' + ' '.repeat(indent * (depth + 1));
	const outer = '\n' + ' '.repeat(indent * depth);
	return open + inner + parts.join(',' + inner) + outer + close;
}

/**
 * `json.dumps(value, ensure_ascii=False, allow_nan=False)` byte for byte:
 * compact separators when `indent` is omitted, Python's indented layout
 * otherwise. Keys keep insertion order. `allowNan` is `allow_nan=True`: a
 * non-finite float is written `NaN`, `Infinity` or `-Infinity`.
 */
export function pyDumps(
	value: Value,
	indent?: number,
	options: { allowNan?: boolean } = {}
): string {
	return dump(value, indent, 0, options.allowNan ?? false);
}
