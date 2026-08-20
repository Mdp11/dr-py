import { describe, expect, it } from 'vitest';

import { FIXTURE } from './__tests__/fixtures';
import { searchTypes } from './diagram-search';
import { parseDraft } from './yaml-edit';

const mm = parseDraft(FIXTURE).mm!;

describe('searchTypes', () => {
	it('returns nothing for an empty or whitespace query', () => {
		expect(searchTypes(mm, '')).toEqual({ hits: [], total: 0 });
		expect(searchTypes(mm, '   ')).toEqual({ hits: [], total: 0 });
	});

	it('matches case-insensitive substrings across all three kinds', () => {
		expect(searchTypes(mm, 'status').hits.map((h) => h.kind)).toEqual(['enum']);
		expect(searchTypes(mm, 'contains').hits.map((h) => h.kind)).toEqual(['relationship']);
		expect(searchTypes(mm, 'zone').hits.map((h) => h.name)).toEqual(['Zone']);
	});

	it('ranks prefix matches before mid-string, then alphabetical', () => {
		// 'o': prefix hit Observes; mid-string hits Contains, Monitors, Zone.
		expect(searchTypes(mm, 'o').hits.map((h) => h.name)).toEqual([
			'Observes',
			'Contains',
			'Monitors',
			'Zone'
		]);
	});

	it('flags mapless relationships', () => {
		const byName = new Map(searchTypes(mm, 's').hits.map((h) => [h.name, h]));
		expect(byName.get('Observes')?.mapless).toBe(true);
		expect(byName.get('Contains')?.mapless).toBe(false);
	});

	it('carries a ready-to-select DiagramSelection', () => {
		expect(searchTypes(mm, 'building').hits[0].sel).toEqual({ kind: 'element', name: 'Building' });
	});

	it('caps the hits at the limit but reports the full match count', () => {
		const all = searchTypes(mm, 'e');
		expect(all.total).toBe(all.hits.length);
		expect(all.total).toBeGreaterThan(2);

		// The cap is what the dropdown's "+N more" note is derived from: it must
		// shorten the list WITHOUT changing the count.
		const capped = searchTypes(mm, 'e', 2);
		expect(capped.hits).toHaveLength(2);
		expect(capped.total).toBe(all.total);
		expect(capped.hits).toEqual(all.hits.slice(0, 2));
	});

	it('reports the match position for the dropdown highlight', () => {
		// 'nit' hits Monitors mid-string at index 2 ("mo-nit-ors").
		const hit = searchTypes(mm, 'nit').hits.find((h) => h.name === 'Monitors');
		expect(hit).toMatchObject({ matchStart: 2, matchLength: 3 });

		// A prefix match starts at index 0.
		const prefixHit = searchTypes(mm, 'zone').hits.find((h) => h.name === 'Zone');
		expect(prefixHit).toMatchObject({ matchStart: 0, matchLength: 4 });
	});
});
