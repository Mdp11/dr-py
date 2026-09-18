import { expect, it } from 'vitest';
import { hashKey } from '../../src/model/hash.ts';

it('hashes a key text to a stable safe integer', () => {
	expect(hashKey('')).toBe(3338908027751811);
	expect(hashKey('a')).toBe(7929297801672961);
	expect(hashKey('["Node",null,[]]')).toBe(hashKey('["Node",null,[]]'));
	expect(hashKey('["Node",null,[]]')).not.toBe(hashKey('["Node",null,[[]]]'));
	for (const text of ['', 'a', '\u{1F600}', 'x'.repeat(1000)]) {
		expect(Number.isSafeInteger(hashKey(text))).toBe(true);
	}
});
