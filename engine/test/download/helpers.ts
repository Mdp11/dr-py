import type { ModelFile } from '../../src/index.ts';

/** A model file's bytes as text; a part that is not whole UTF-8 fails it. */
export function fileText(file: ModelFile): string {
	const decoder = new TextDecoder('utf-8', { fatal: true });
	return (
		file.parts.map((part) => decoder.decode(part, { stream: true })).join('') + decoder.decode()
	);
}

/** `parts` joined into one byte array. */
export function joined(parts: readonly ArrayBuffer[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
	let at = 0;
	for (const part of parts) {
		out.set(new Uint8Array(part), at);
		at += part.byteLength;
	}
	return out;
}
