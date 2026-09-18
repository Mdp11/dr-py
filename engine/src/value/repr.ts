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
