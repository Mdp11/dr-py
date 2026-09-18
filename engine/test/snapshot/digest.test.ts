import { expect, it } from 'vitest';
import { entityHash, formatDigest, Model, modelDigest } from '../../src/index.ts';
import { entityHash as referenceHash, stateDigest } from '../golden/digest.ts';
import { seededRandom } from '../golden/model-steps.ts';
import { family, nodeMetamodel } from '../model/fixtures.ts';

it("reproduces the server's entity hashes", () => {
	// The vectors of tests/api/test_state_digest.py.
	const vectors: [string, number, string][] = [
		['id-1', 0, 'b83d885159d11dd4'],
		['id-1', 1, '14d07545607c068e'],
		['', 0, 'db3426e878068d28'],
		['caf\u{e9}', 12, 'c9524fe14dc453b5'],
		['\u{1f600}', 3, '7907ed2f4cfeac90']
	];
	for (const [id, rev, expected] of vectors) {
		expect(formatDigest(entityHash(id, rev)), JSON.stringify(id)).toBe(expected);
	}
});

it('agrees with the reference hash on ids of every width and length', () => {
	const random = seededRandom(7);
	const alphabet = ['a', 'Z', '0', '-', '\u{e9}', '\u{3a9}', '\u{20ac}', '\u{2028}', '\u{1f600}'];
	for (let round = 0; round < 400; round++) {
		// Past 85 letters the message buffer grows; past 55 bytes the hash takes a second block.
		const length = round % 8 === 0 ? 90 + Math.floor(random() * 300) : Math.floor(random() * 60);
		let id = '';
		for (let i = 0; i < length; i++) id += alphabet[Math.floor(random() * alphabet.length)];
		const rev = Math.floor(random() * 2 ** (round % 41));
		expect(entityHash(id, rev), `${JSON.stringify(id)} @ ${rev}`).toBe(referenceHash(id, rev));
	}
});

it('writes a lone surrogate as U+FFFD, as TextEncoder does', () => {
	expect(entityHash('a\u{d800}b', 1)).toBe(entityHash('a\u{fffd}b', 1));
	expect(entityHash('\u{dc00}', 1)).toBe(referenceHash('\u{dc00}', 1));
	expect(entityHash('\u{d83d}', 1)).toBe(referenceHash('\u{d83d}', 1));
});

it('formats a digest as sixteen lower-case hex digits', () => {
	expect(formatDigest(0n)).toBe('0000000000000000');
	expect(formatDigest(0xabn)).toBe('00000000000000ab');
	expect(formatDigest(2n ** 64n - 1n)).toBe('ffffffffffffffff');
});

it('folds every element and relationship of a model, in any order', () => {
	expect(modelDigest(new Model(nodeMetamodel()))).toBe('0000000000000000');
	const model = family();
	expect(modelDigest(model)).toBe(stateDigest(model));
	let value = 0n;
	for (const rel of [...model.relationships()].reverse()) value ^= entityHash(rel.id, rel.rev);
	for (const element of [...model.elements()].reverse()) {
		value ^= entityHash(element.id, element.rev);
	}
	expect(formatDigest(value)).toBe(modelDigest(model));
});

it('sees two ids exchanging their revs', () => {
	expect(entityHash('a', 2) ^ entityHash('b', 10)).not.toBe(
		entityHash('a', 10) ^ entityHash('b', 2)
	);
});
