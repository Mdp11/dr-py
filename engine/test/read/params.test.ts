import { describe, expect, it } from 'vitest';
import { directionOf, idsOf, pageOf, ReadError } from '../../src/index.ts';
import { thrown } from '../golden/thrown.ts';

function refusal(read: () => unknown): [number, string] {
	const error = thrown(read);
	expect(error).toBeInstanceOf(ReadError);
	return [(error as ReadError).status, (error as ReadError).detail];
}

const LIMIT = [422, 'limit must be an integer from 1 to 500'];
const OFFSET = [422, 'offset must be an integer of at least 0'];

describe('pageOf', () => {
	it('defaults to the first 100', () => {
		expect(pageOf({})).toEqual({ limit: 100, offset: 0 });
	});

	it('takes a limit from 1 to 500 and any offset from 0', () => {
		expect(pageOf({ limit: 1, offset: 0 })).toEqual({ limit: 1, offset: 0 });
		expect(pageOf({ limit: 500, offset: 10_000 })).toEqual({ limit: 500, offset: 10_000 });
	});

	it.each([0, 501, 1.5, '7', null])('refuses limit %j', (limit) => {
		expect(refusal(() => pageOf({ limit }))).toEqual(LIMIT);
	});

	it.each([-1, 0.5, '0', null])('refuses offset %j', (offset) => {
		expect(refusal(() => pageOf({ offset }))).toEqual(OFFSET);
	});
});

describe('directionOf', () => {
	it('defaults to both and takes the three', () => {
		expect(directionOf({})).toBe('both');
		for (const direction of ['both', 'in', 'out'])
			expect(directionOf({ direction })).toBe(direction);
	});

	it('refuses anything else', () => {
		expect(refusal(() => directionOf({ direction: 'up' }))).toEqual([
			422,
			"direction must be 'both', 'in' or 'out'"
		]);
	});
});

describe('idsOf', () => {
	it('takes a list of strings, up to 500', () => {
		expect(idsOf({ ids: ['a', 'a'] })).toEqual(['a', 'a']);
		expect(idsOf({ ids: Array<string>(500).fill('x') })).toHaveLength(500);
	});

	it('refuses a non-list, a non-string member, and more than 500 in the route words', () => {
		const shape = [422, 'ids must be a list of strings'];
		expect(refusal(() => idsOf({ ids: 'a' }))).toEqual(shape);
		expect(refusal(() => idsOf({ ids: ['a', 1] }))).toEqual(shape);
		expect(refusal(() => idsOf({}))).toEqual(shape);
		expect(refusal(() => idsOf({ ids: Array<string>(501).fill('x') }))).toEqual([
			422,
			'too many ids: 501 (max 500)'
		]);
	});
});
