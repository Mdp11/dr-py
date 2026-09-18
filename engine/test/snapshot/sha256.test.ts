import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { sha256 } from '../../src/snapshot/sha256.ts';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const ascii = (text: string) => Uint8Array.from(text, (ch) => ch.charCodeAt(0));

it('hashes the FIPS 180-4 example messages', () => {
	const vectors: [string, string][] = [
		['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
		['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
		[
			'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
			'248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'
		],
		[
			'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmno' +
				'ijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
			'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1'
		]
	];
	for (const [message, expected] of vectors) expect(hex(sha256(ascii(message)))).toBe(expected);
});

it('hashes a million letters', () => {
	const expected = 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0';
	expect(hex(sha256(new Uint8Array(1_000_000).fill(0x61)))).toBe(expected);
});

it('pads every length around the block boundaries as the reference does', () => {
	for (let length = 0; length <= 200; length++) {
		const data = Uint8Array.from({ length }, (_, i) => (i * 131 + length) & 0xff);
		expect(hex(sha256(data)), `length ${length}`).toBe(
			createHash('sha256').update(data).digest('hex')
		);
	}
});

it('leaves its input alone and keeps no state between calls', () => {
	const data = ascii('abc');
	const first = hex(sha256(data));
	sha256(new Uint8Array(100).fill(7));
	expect(hex(sha256(data))).toBe(first);
	expect(data).toEqual(ascii('abc'));
});
