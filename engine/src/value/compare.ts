function isHighSurrogate(unit: number): boolean {
	return unit >= 0xd800 && unit <= 0xdbff;
}

/**
 * Orders strings by code point, as Python compares `str`. JavaScript's `<`
 * compares UTF-16 code units, which puts astral characters below U+E000–U+FFFF.
 */
export function cmpCodePoint(a: string, b: string): number {
	const n = Math.min(a.length, b.length);
	let i = 0;
	while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
	if (i === n) return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
	if (i > 0 && isHighSurrogate(a.charCodeAt(i - 1))) {
		// The difference may sit in the second half of a surrogate pair.
		const x = a.codePointAt(i - 1)!;
		const y = b.codePointAt(i - 1)!;
		if (x !== y) return x < y ? -1 : 1;
	}
	const x = a.codePointAt(i)!;
	const y = b.codePointAt(i)!;
	return x < y ? -1 : 1;
}

const isLow = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;
const splitsPair = (text: string, at: number) =>
	at > 0 &&
	at < text.length &&
	isHighSurrogate(text.charCodeAt(at - 1)) &&
	isLow(text.charCodeAt(at));

/** Python's `needle in haystack`, over code points: a match never splits a surrogate pair. */
export function pyContains(haystack: string, needle: string): boolean {
	for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) {
		if (!splitsPair(haystack, at) && !splitsPair(haystack, at + needle.length)) return true;
	}
	return false;
}
