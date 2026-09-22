import { describe, expect, it } from 'vitest';
import { placedElementIds } from '../placements';

describe('placedElementIds', () => {
	it('walks nested folders, each id once in first-seen order', () => {
		const view = {
			folders: [
				{
					elements: ['a', 'b'],
					folders: [
						{ elements: ['c', 'a'], folders: [{ elements: ['d'], folders: [] }] },
						{ elements: ['b', 'e'], folders: [] }
					]
				},
				{ elements: ['f', 'c'], folders: [] }
			]
		};
		expect(placedElementIds(view)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
	});

	it('ignores artifacts and keeps ids the model may not hold', () => {
		const view = {
			folders: [
				{
					elements: ['not-in-the-model'],
					artifacts: ['art-1'],
					folders: [{ elements: [], artifacts: ['art-2'], folders: [] }]
				}
			],
			artifacts: ['art-3']
		};
		expect(placedElementIds(view)).toEqual(['not-in-the-model']);
	});

	it('an empty view places nothing', () => {
		expect(placedElementIds({ folders: [] })).toEqual([]);
		expect(placedElementIds({ folders: [{ elements: [], folders: [] }] })).toEqual([]);
	});
});
