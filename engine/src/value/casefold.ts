import { CASEFOLD_SPECIAL } from './casefold-tables.ts';
import { LOWER_PAIRS, LOWER_SPECIAL } from './lower-tables.ts';

const ASCII = /^\p{ASCII}*$/u;

let folded: Map<number, string> | undefined;

// Each code point's lowercase alone, then the code points whose casefold differs.
function foldTable(): Map<number, string> {
	if (folded === undefined) {
		const table = new Map<number, string>();
		for (let i = 0; i < LOWER_PAIRS.length; i += 2) {
			table.set(LOWER_PAIRS[i]!, String.fromCodePoint(LOWER_PAIRS[i + 1]!));
		}
		for (const special of [LOWER_SPECIAL, CASEFOLD_SPECIAL]) {
			for (let i = 0; i < special.length;) {
				const count = special[i + 1]!;
				table.set(special[i]!, String.fromCodePoint(...special.slice(i + 2, i + 2 + count)));
				i += 2 + count;
			}
		}
		folded = table;
	}
	return folded;
}

/**
 * `str.casefold()` of the Python the engine mirrors: per code point, with no
 * context, so a final sigma folds as any other.
 */
export function pyCasefold(text: string): string {
	if (ASCII.test(text)) return text.toLowerCase();
	const table = foldTable();
	let out = '';
	for (let i = 0; i < text.length;) {
		const cp = text.codePointAt(i)!;
		const size = cp > 0xffff ? 2 : 1;
		out += table.get(cp) ?? text.slice(i, i + size);
		i += size;
	}
	return out;
}
