import { describe, expect, it } from 'vitest';
import { PART_BYTES, PartWriter, ReadError } from '../../src/index.ts';
import { thrown } from '../golden/thrown.ts';
import { joined } from './helpers.ts';

const utf8 = (text: string) => new TextEncoder().encode(text);

function written(pieces: readonly string[], partBytes?: number): ArrayBuffer[] {
	const writer = new PartWriter(partBytes);
	for (const piece of pieces) writer.write(piece);
	return writer.finish();
}

describe('PartWriter', () => {
	it('parts of 4 MiB by default', () => {
		expect(PART_BYTES).toBe(4 * 1024 * 1024);
		const parts = written(['x'.repeat(PART_BYTES + 3)]);
		expect(parts.map((part) => part.byteLength)).toEqual([PART_BYTES, 3]);
	});

	it('never splits a character across parts, and the parts join to the exact UTF-8', () => {
		const pieces = ['{"a": "é✓𝄞', '"}', '', 'x𝄞𝄞é', '✓✓', 'plain ascii text', '𝄞'];
		const text = pieces.join('');
		for (const partBytes of [4, 5, 6, 7, 8, 16]) {
			const parts = written(pieces, partBytes);
			expect(joined(parts), `${partBytes}`).toEqual(utf8(text));
			for (const part of parts) {
				expect(part.byteLength).toBeGreaterThan(0);
				expect(part.byteLength).toBeLessThanOrEqual(partBytes);
				// Each part decodes alone: no character straddles two.
				expect(() => new TextDecoder('utf-8', { fatal: true }).decode(part)).not.toThrow();
			}
		}
	});

	it('leaves no empty part after text that fills its parts exactly', () => {
		expect(written(['abcdefg', 'hijklmn'], 7).map((part) => part.byteLength)).toEqual([7, 7]);
		expect(written(['abc', 'defghijklmn'], 7).map((part) => part.byteLength)).toEqual([7, 7]);
		expect(written(['abcdefg'], 7).map((part) => part.byteLength)).toEqual([7]);
	});

	it('gives zero parts for no text', () => {
		expect(written([], 7)).toEqual([]);
		expect(written(['', ''], 7)).toEqual([]);
	});

	it('gives every part a buffer of its own, of its own length', () => {
		const parts = written(['é'.repeat(10)], 7);
		// 3 two-byte characters fit a part of 7: its last byte stays unused.
		expect(parts.map((part) => part.byteLength)).toEqual([6, 6, 6, 2]);
		expect(new Set(parts).size).toBe(parts.length);
	});

	it('refuses a lone surrogate at its position in code points from the start of the document', () => {
		const writer = new PartWriter(7);
		writer.write('{"𝄞": ');
		writer.write('"é✓", ');
		const error = thrown(() => writer.write('"x\ud800y"'));
		expect(error).toBeInstanceOf(ReadError);
		// '{"𝄞": ' is 6 code points, '"é✓", ' 6, then '"x' 2.
		expect(error).toMatchObject({
			status: 422,
			detail:
				"'utf-8' codec can't encode character '\\ud800' in position 14: surrogates not allowed"
		});
		const run = thrown(() => {
			const other = new PartWriter(7);
			other.write('𝄞');
			other.write('ab\udc00\ud800');
		});
		expect(run).toMatchObject({
			status: 422,
			detail: "'utf-8' codec can't encode characters in position 3-4: surrogates not allowed"
		});
	});
});
