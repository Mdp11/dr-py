import type { Metamodel } from '../metamodel/metamodel.ts';
import { cmpCodePoint } from '../value/compare.ts';
import { pyFloatRepr } from '../value/float-repr.ts';
import { pyRepr, pyReprValue } from '../value/repr.ts';
import { PyFloat, type Value } from '../value/types.ts';

/** Whether one scalar item fits a property's datatype, as the Python core decides it. */
export function valueConforms(value: Value, datatype: string, mm: Metamodel): boolean {
	if (Object.hasOwn(mm.enums, datatype)) {
		return typeof value === 'string' && mm.enums[datatype]!.includes(value);
	}
	switch (datatype) {
		case 'string':
			return typeof value === 'string';
		case 'boolean':
			return typeof value === 'boolean';
		case 'integer':
			return typeof value === 'number' || typeof value === 'bigint';
		case 'float':
			return (
				typeof value === 'number' ||
				typeof value === 'bigint' ||
				value instanceof PyFloat ||
				value === 'Infinity' ||
				value === '-Infinity'
			);
		case 'date':
			return typeof value === 'string' && pyIsoDate(value);
	}
	return false;
}

// -- date.fromisoformat ---------------------------------------------------------

const DASH = 0x2d;
const W = 0x57;
const MAX_ORDINAL = 3652059; // 9999-12-31
const DAYS_BEFORE_MONTH = [0, 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

const isLeap = (y: number) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);

function daysInMonth(y: number, m: number): number {
	if (m === 2) return isLeap(y) ? 29 : 28;
	return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** Day 1 is 0001-01-01, a Monday. */
function ordinal(y: number, m: number, d: number): number {
	const p = y - 1;
	const before = p * 365 + Math.floor(p / 4) - Math.floor(p / 100) + Math.floor(p / 400);
	return before + DAYS_BEFORE_MONTH[m]! + (m > 2 && isLeap(y) ? 1 : 0) + d;
}

/** `iso_to_ymd` and the year range of the date it gives. */
function isoWeekDateOk(year: number, week: number, day: number): boolean {
	if (year < 1 || year > 9999) return false;
	const first = ordinal(year, 1, 1);
	const firstWeekday = (first + 6) % 7;
	if (week <= 0 || week >= 53) {
		// A year has a week 53 when it starts on a Thursday, or on a Wednesday in a leap year.
		const has53 = firstWeekday === 3 || (firstWeekday === 2 && isLeap(year));
		if (week !== 53 || !has53) return false;
	}
	if (day <= 0 || day >= 8) return false;
	const week1Monday = first - firstWeekday + (firstWeekday > 3 ? 7 : 0);
	const at = week1Monday + (week - 1) * 7 + day - 1;
	return at >= 1 && at <= MAX_ORDINAL;
}

/** The UTF-8 bytes of `s`, or `null` for a lone surrogate, which Python cannot encode. */
function utf8(s: string): number[] | null {
	const out: number[] = [];
	for (let i = 0; i < s.length; i++) {
		let cp = s.charCodeAt(i);
		if (cp >= 0xdc00 && cp <= 0xdfff) return null;
		if (cp >= 0xd800 && cp <= 0xdbff) {
			const low = s.charCodeAt(i + 1);
			if (!(low >= 0xdc00 && low <= 0xdfff)) return null;
			cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
			i++;
		}
		if (cp < 0x80) out.push(cp);
		else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
		else if (cp < 0x10000) {
			out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
		} else {
			out.push(
				0xf0 | (cp >> 18),
				0x80 | ((cp >> 12) & 63),
				0x80 | ((cp >> 6) & 63),
				0x80 | (cp & 63)
			);
		}
	}
	return out;
}

/**
 * Whether `datetime.date.fromisoformat(s)` accepts `s`: CPython's parser,
 * which reads the UTF-8 bytes of a text 7, 8 or 10 bytes long as
 * `YYYY-MM-DD`, `YYYYMMDD`, `YYYY-Www[-D]` or `YYYYWww[D]`, ASCII digits only.
 * It never checks that it reached the end, so the last two bytes of a
 * 10-byte text without dashes are not read at all (`20240101xx`).
 */
export function pyIsoDate(s: string): boolean {
	// UTF-8 never takes fewer bytes than UTF-16 takes units.
	if (s.length > 10) return false;
	const bytes = utf8(s);
	if (bytes === null) return false;
	const len = bytes.length;
	if (len !== 7 && len !== 8 && len !== 10) return false;
	// The C parser reads a NUL-terminated buffer.
	const at = (i: number) => (i < len ? bytes[i]! : 0);
	let p = 0;
	const digits = (count: number): number => {
		let value = 0;
		for (let k = 0; k < count; k++) {
			const digit = at(p++) - 0x30;
			if (digit < 0 || digit > 9) return -1;
			value = value * 10 + digit;
		}
		return value;
	};
	const year = digits(4);
	if (year < 0) return false;
	const dashes = at(p) === DASH;
	if (dashes) p++;
	if (at(p) === W) {
		p++;
		const week = digits(2);
		if (week < 0) return false;
		let day = 1;
		if (p < len) {
			if (dashes && at(p++) !== DASH) return false;
			day = digits(1);
			if (day < 0) return false;
		}
		return isoWeekDateOk(year, week, day);
	}
	const month = digits(2);
	if (month < 0) return false;
	if (dashes && at(p++) !== DASH) return false;
	const day = digits(2);
	if (day < 0) return false;
	return (
		year >= 1 &&
		year <= 9999 &&
		month >= 1 &&
		month <= 12 &&
		day >= 1 &&
		day <= daysInMonth(year, month)
	);
}

// -- renderings -----------------------------------------------------------------

/** `str()` of a number: an int in decimal, a float as `repr` writes it. */
export function pyStrNumber(v: number | bigint | PyFloat): string {
	return v instanceof PyFloat ? pyFloatRepr(v.value) : v.toString();
}

function tuple(items: readonly string[]): string {
	return items.length === 1 ? `(${items[0]},)` : `(${items.join(', ')})`;
}

/**
 * `repr` of a value frozen as the uniqueness signature freezes it: a list
 * becomes a tuple, a dict a tuple of `(key, value)` pairs sorted by key.
 */
export function pyReprFrozen(v: Value): string {
	if (Array.isArray(v)) return tuple(v.map(pyReprFrozen));
	if (v !== null && typeof v === 'object' && !(v instanceof PyFloat)) {
		const keys = Object.keys(v).sort(cmpCodePoint);
		return tuple(keys.map((key) => tuple([pyRepr(key), pyReprFrozen(v[key]!)])));
	}
	return pyReprValue(v);
}
