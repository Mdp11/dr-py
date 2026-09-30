import { pyFloatRepr } from './float-repr.ts';
import { PyFloat, type Value } from './types.ts';

// What `json.dumps(ensure_ascii=False)` escapes: the quote, the backslash and
// the C0 controls. Everything else is written raw.
// eslint-disable-next-line no-control-regex
const MUST_ESCAPE = /["\\\x00-\x1f]/g;
// `ensure_ascii=True` additionally escapes every UTF-16 code unit above 0x7f.
// eslint-disable-next-line no-control-regex
const MUST_ESCAPE_ASCII = /["\\\x00-\x1f\x7f-\uffff]/g;
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

function dumpString(s: string, ascii: boolean): string {
	return '"' + s.replace(ascii ? MUST_ESCAPE_ASCII : MUST_ESCAPE, escapeChar) + '"';
}

interface Style {
	indent: number | undefined;
	allowNan: boolean;
	ascii: boolean;
	itemSep: string;
	keySep: string;
}

function dumpScalar(v: null | boolean | number | bigint | string | PyFloat, st: Style): string {
	if (v === null) return 'null';
	if (typeof v === 'string') return dumpString(v, st.ascii);
	if (typeof v === 'boolean') return v ? 'true' : 'false';
	if (v instanceof PyFloat) {
		if (!Number.isFinite(v.value)) {
			if (!st.allowNan) throw new RangeError('Out of range float values are not JSON compliant');
			return Number.isNaN(v.value) ? 'NaN' : v.value > 0 ? 'Infinity' : '-Infinity';
		}
		return pyFloatRepr(v.value);
	}
	return v.toString();
}

function dump(v: Value, depth: number, st: Style): string {
	if (typeof v !== 'object' || v === null || v instanceof PyFloat) return dumpScalar(v, st);
	const isArray = Array.isArray(v);
	const parts = isArray
		? v.map((item) => dump(item, depth + 1, st))
		: Object.entries(v).map(
				([key, item]) => dumpString(key, st.ascii) + st.keySep + dump(item, depth + 1, st)
			);
	const [open, close] = isArray ? '[]' : '{}';
	if (parts.length === 0) return open! + close!;
	if (st.indent === undefined) return open + parts.join(st.itemSep) + close;
	const inner = '\n' + ' '.repeat(st.indent * (depth + 1));
	const outer = '\n' + ' '.repeat(st.indent * depth);
	return open + inner + parts.join(',' + inner) + outer + close;
}

/**
 * `json.dumps(value, ensure_ascii=False, allow_nan=False)` byte for byte:
 * compact separators when `indent` is omitted, Python's indented layout
 * otherwise. Keys keep insertion order. `allowNan` is `allow_nan=True`: a
 * non-finite float is written `NaN`, `Infinity` or `-Infinity`. `ascii` is
 * `ensure_ascii=True`. `spaced` writes `", "` and `": "` instead of the compact
 * separators when `indent` is omitted, so all three together are bare
 * `json.dumps(value)`.
 */
export function pyDumps(
	value: Value,
	indent?: number,
	options: { allowNan?: boolean; ascii?: boolean; spaced?: boolean } = {}
): string {
	const spaced = options.spaced ?? false;
	return dump(value, 0, {
		indent,
		allowNan: options.allowNan ?? false,
		ascii: options.ascii ?? false,
		itemSep: spaced ? ', ' : ',',
		keySep: indent !== undefined || spaced ? ': ' : ':'
	});
}
