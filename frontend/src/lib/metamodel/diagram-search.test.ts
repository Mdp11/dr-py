import { describe, expect, it } from 'vitest';

import { FIXTURE } from './__tests__/fixtures';
import { searchTypes } from './diagram-search';
import { parseDraft } from './yaml-edit';

const mm = parseDraft(FIXTURE).mm!;

describe('searchTypes', () => {
	it('returns nothing for an empty or whitespace query', () => {
		expect(searchTypes(mm, '')).toEqual([]);
		expect(searchTypes(mm, '   ')).toEqual([]);
	});

	it('matches case-insensitive substrings across all three kinds', () => {
		expect(searchTypes(mm, 'status').map((h) => h.kind)).toEqual(['enum']);
		expect(searchTypes(mm, 'contains').map((h) => h.kind)).toEqual(['relationship']);
		expect(searchTypes(mm, 'zone').map((h) => h.name)).toEqual(['Zone']);
	});

	it('ranks prefix matches before mid-string, then alphabetical', () => {
		// 'o': prefix hit Observes; mid-string hits Contains, Monitors, Zone.
		expect(searchTypes(mm, 'o').map((h) => h.name)).toEqual([
			'Observes',
			'Contains',
			'Monitors',
			'Zone'
		]);
	});

	it('flags mapless relationships', () => {
		const byName = new Map(searchTypes(mm, 's').map((h) => [h.name, h]));
		expect(byName.get('Observes')?.mapless).toBe(true);
		expect(byName.get('Contains')?.mapless).toBe(false);
	});

	it('carries a ready-to-select DiagramSelection', () => {
		expect(searchTypes(mm, 'building')[0].sel).toEqual({ kind: 'element', name: 'Building' });
	});

	it('caps at the limit', () => {
		expect(searchTypes(mm, 'e', 2)).toHaveLength(2);
	});

	it('reports the match position for the dropdown highlight', () => {
		// 'nit' hits Monitors mid-string at index 2 ("mo-nit-ors").
		const hit = searchTypes(mm, 'nit').find((h) => h.name === 'Monitors');
		expect(hit).toMatchObject({ matchStart: 2, matchLength: 3 });

		// A prefix match starts at index 0.
		const prefixHit = searchTypes(mm, 'zone').find((h) => h.name === 'Zone');
		expect(prefixHit).toMatchObject({ matchStart: 0, matchLength: 4 });
	});
});
