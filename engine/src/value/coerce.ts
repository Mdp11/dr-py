/**
 * The criteria's "JavaScript" coercion is Python's `str()` and `float()` in
 * fact (`core/search/criteria.py::_js_str` / `_to_number`); this ports both.
 */
import { DECIMAL_DIGITS, SPACE_POINTS } from './digit-tables.ts';
import { pyFloatRepr } from './float-repr.ts';
import { pyStrip } from './lower.ts';
import { pyReprValue } from './repr.ts';
import { PyFloat, type Value } from './types.ts';

/** `float(int)` past the double range: Python's `OverflowError`. */
export class PyOverflowError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PyOverflowError';
	}
}

let digitOfCodePoint: Map<number, number> | undefined;

function digitOf(cp: number): number | undefined {
	if (digitOfCodePoint === undefined) {
		const table = new Map<number, number>();
		for (let i = 0; i < DECIMAL_DIGITS.length; i += 2) {
			table.set(DECIMAL_DIGITS[i]!, DECIMAL_DIGITS[i + 1]!);
		}
		digitOfCodePoint = table;
	}
	return digitOfCodePoint.get(cp);
}

let spacePoints: Set<number> | undefined;

function isSpacePoint(cp: number): boolean {
	if (spacePoints === undefined) spacePoints = new Set(SPACE_POINTS);
	return spacePoints.has(cp);
}

// Every code point past ASCII becomes its ASCII decimal digit or a space, the
// transform CPython's float parser applies before the grammar; an ASCII code
// point (control characters included) is never touched by it.
function normalizeDigits(text: string): string {
	let out = '';
	for (const ch of text) {
		const cp = ch.codePointAt(0)!;
		if (cp < 127) {
			out += ch;
			continue;
		}
		const digit = digitOf(cp);
		if (digit !== undefined) out += digit;
		else if (isSpacePoint(cp)) out += ' ';
		else out += ch;
	}
	return out;
}

// The grammar's own leading/trailing strip: the six classic ASCII whitespace
// characters, narrower than `str.isspace()` (a control character such as
// U+001C fails to parse although `str.isspace()` accepts it).
const ASCII_SPACE = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20]);

function stripAsciiSpace(text: string): string {
	let start = 0;
	let end = text.length;
	while (start < end && ASCII_SPACE.has(text.charCodeAt(start))) start++;
	while (end > start && ASCII_SPACE.has(text.charCodeAt(end - 1))) end--;
	return text.slice(start, end);
}

const DIGITS = '[0-9](?:_?[0-9])*';
const NUMBER = new RegExp(
	`^[+-]?(?:${DIGITS}(?:\\.(?:${DIGITS})?)?|\\.${DIGITS})(?:[eE][+-]?${DIGITS})?$`
);
const SPECIAL = /^([+-]?)(inf|infinity|nan)$/i;

/** `float(text)`, or `null` where Python raises `ValueError`. */
export function pyFloatOf(text: string): number | null {
	const trimmed = stripAsciiSpace(normalizeDigits(text));
	const special = SPECIAL.exec(trimmed);
	if (special) {
		const word = special[2]!.toLowerCase();
		if (word === 'nan') return NaN;
		return special[1] === '-' ? -Infinity : Infinity;
	}
	if (!NUMBER.test(trimmed)) return null;
	return Number(trimmed.replace(/_/g, ''));
}

/** `String(value)` for the JSON scalar types model properties hold — the
 * criteria's own name for `str()`, integral floats without a trailing `.0`. */
export function jsStr(value: Value): string {
	if (value === true) return 'true';
	if (value === false) return 'false';
	if (value instanceof PyFloat) {
		const x = value.value;
		if (Number.isFinite(x) && Number.isInteger(x)) return BigInt(x).toString();
		return pyFloatRepr(x);
	}
	if (typeof value === 'number') return String(value);
	if (typeof value === 'bigint') return value.toString();
	if (typeof value === 'string') return value;
	if (value === null) return 'None';
	return pyReprValue(value);
}

/** `Number(raw)` semantics for a criterion's numeric operators: missing
 * (`undefined`) → NaN, `null` → 0, a bool → 0/1, a blank string → 0,
 * unparseable → NaN; an int past the double range throws `PyOverflowError`. */
export function toNumber(raw: Value | undefined): number {
	if (raw === undefined) return NaN;
	if (raw === null) return 0;
	if (raw === true) return 1;
	if (raw === false) return 0;
	if (typeof raw === 'number') return raw;
	if (typeof raw === 'bigint') {
		const n = Number(raw);
		if (!Number.isFinite(n)) throw new PyOverflowError('int too large to convert to float');
		return n;
	}
	if (raw instanceof PyFloat) return raw.value;
	if (typeof raw === 'string') {
		const s = pyStrip(raw);
		if (s === '') return 0;
		const f = pyFloatOf(s);
		return f === null ? NaN : f;
	}
	return NaN;
}
