import { CASE_IGNORABLE_RANGES, CASED_RANGES, LOWER_PAIRS, LOWER_SPECIAL } from './lower-tables.ts';

const ASCII = /^\p{ASCII}*$/u;
const CAPITAL_SIGMA = 0x3a3;

// `str.isspace()`: what `str.strip()` removes.
const SPACE = new Set([
	0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001,
	0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f,
	0x205f, 0x3000
]);

let lowered: Map<number, string> | undefined;

function lowerTable(): Map<number, string> {
	if (lowered === undefined) {
		const table = new Map<number, string>();
		for (let i = 0; i < LOWER_PAIRS.length; i += 2) {
			table.set(LOWER_PAIRS[i]!, String.fromCodePoint(LOWER_PAIRS[i + 1]!));
		}
		for (let i = 0; i < LOWER_SPECIAL.length;) {
			const count = LOWER_SPECIAL[i + 1]!;
			table.set(
				LOWER_SPECIAL[i]!,
				String.fromCodePoint(...LOWER_SPECIAL.slice(i + 2, i + 2 + count))
			);
			i += 2 + count;
		}
		lowered = table;
	}
	return lowered;
}

function inRanges(ranges: readonly number[], cp: number): boolean {
	let lo = 0;
	let hi = ranges.length / 2 - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (cp < ranges[2 * mid]!) hi = mid - 1;
		else if (cp > ranges[2 * mid + 1]!) lo = mid + 1;
		else return true;
	}
	return false;
}

/** The code point that ends just before UTF-16 index `end`, and where it starts. */
function before(text: string, end: number): [cp: number, start: number] {
	const low = text.charCodeAt(end - 1);
	if (low >= 0xdc00 && low <= 0xdfff && end >= 2) {
		const high = text.charCodeAt(end - 2);
		if (high >= 0xd800 && high <= 0xdbff) return [text.codePointAt(end - 2)!, end - 2];
	}
	return [low, end - 1];
}

// Python's Final_Sigma context: a cased code point before the sigma and none
// after it, case-ignorable ones skipped on both sides.
function finalSigma(text: string, at: number): boolean {
	let j = at;
	let cp = -1;
	while (j > 0) {
		[cp, j] = before(text, j);
		if (!inRanges(CASE_IGNORABLE_RANGES, cp)) break;
		cp = -1;
	}
	if (cp < 0 || !inRanges(CASED_RANGES, cp)) return false;
	for (let k = at + 1; k < text.length;) {
		const next = text.codePointAt(k)!;
		if (!inRanges(CASE_IGNORABLE_RANGES, next)) return !inRanges(CASED_RANGES, next);
		k += next > 0xffff ? 2 : 1;
	}
	return true;
}

/** `str.lower()` of the Python the engine mirrors, whatever Unicode the host carries. */
export function pyLower(text: string): string {
	if (ASCII.test(text)) return text.toLowerCase();
	const table = lowerTable();
	let out = '';
	for (let i = 0; i < text.length;) {
		const cp = text.codePointAt(i)!;
		const size = cp > 0xffff ? 2 : 1;
		if (cp === CAPITAL_SIGMA) out += finalSigma(text, i) ? 'ς' : 'σ';
		else out += table.get(cp) ?? text.slice(i, i + size);
		i += size;
	}
	return out;
}

/** `str.strip()` with no argument. */
export function pyStrip(text: string): string {
	let start = 0;
	let end = text.length;
	while (start < end && SPACE.has(text.charCodeAt(start))) start++;
	while (end > start && SPACE.has(text.charCodeAt(end - 1))) end--;
	return start === 0 && end === text.length ? text : text.slice(start, end);
}
