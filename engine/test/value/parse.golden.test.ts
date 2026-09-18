import { expect, it } from 'vitest';
import { parseExact, parseJson } from '../../src/index.ts';
import { loadFixture, sameValue, untag, type Tagged } from '../golden/load.ts';

it('parses JSON to the same values as parse_model_json', () => {
	const cases = loadFixture<{ text: string; value: Tagged }[]>('json_parse');
	for (const c of cases) {
		const expected = untag(c.value);
		expect(sameValue(parseJson(c.text), expected), `parseJson ${c.text}`).toBe(true);
		expect(sameValue(parseExact(c.text), expected), `parseExact ${c.text}`).toBe(true);
	}
});
