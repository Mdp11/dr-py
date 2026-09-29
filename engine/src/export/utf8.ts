/**
 * UTF-8 as a shipped file needs it: Python's encoder refuses a lone
 * surrogate, so the engine refuses it in the same words.
 */
import { ReadError } from '../read/errors.ts';

type Encoder = {
	encode(text: string): Uint8Array<ArrayBuffer>;
	encodeInto(text: string, into: Uint8Array): { read: number; written: number };
};

// Looked up rather than declared, as `utf8Decoder` looks up its decoder.
export function utf8Encoder(): Encoder {
	const host = globalThis as unknown as { TextEncoder?: new () => Encoder };
	if (host.TextEncoder === undefined) throw new Error('This host has no TextEncoder');
	return new host.TextEncoder();
}

const LONE_SURROGATES = /\p{Cs}+/u;

/**
 * Python's refusal to encode `text`'s first run of lone surrogates, its
 * position in code points from the start of the text, or of its line when
 * each line is encoded alone; `null` when `text` encodes. `offset` code
 * points stand before the text.
 */
export function surrogateRefusal(text: string, byLine = false, offset = 0): ReadError | null {
	const lone = LONE_SURROGATES.exec(text);
	if (lone === null) return null;
	const start = byLine ? text.lastIndexOf('\n', lone.index - 1) + 1 : 0;
	const at = offset + Array.from(text.slice(start, lone.index)).length;
	const run = lone[0];
	const where =
		run.length === 1
			? `character '\\u${run.charCodeAt(0).toString(16)}' in position ${at}`
			: `characters in position ${at}-${at + run.length - 1}`;
	return new ReadError(422, `'utf-8' codec can't encode ${where}: surrogates not allowed`);
}

/** `text` as UTF-8, or Python's refusal of a lone surrogate. */
export function utf8(text: string, byLine: boolean): Uint8Array {
	const refusal = surrogateRefusal(text, byLine);
	if (refusal !== null) throw refusal;
	return utf8Encoder().encode(text);
}
