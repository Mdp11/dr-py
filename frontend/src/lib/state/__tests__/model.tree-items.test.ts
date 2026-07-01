import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';

import type { OpsResponse } from '$lib/api/types';
import { server } from '../../api/__tests__/server';
import {
	applyDelta,
	ensureTreeItems,
	getCachedTreeItems,
	getModelRev,
	getTreeElements,
	seedTreeItems,
	seedElements,
	resetModelStore,
	getMissingElementIds,
	setModelApiConfig
} from '../model.svelte';

const BASE = 'http://api.test/api/v1';

/** Mirrors the sibling `delta()` helper in `model-store.test.ts` — every
 * `OpsResponse` field filled so `applyDelta` (which reads `Object.keys(d.id_map)`
 * unconditionally) never sees `undefined`. */
function delta(partial: Partial<OpsResponse>): OpsResponse {
	return {
		model_rev: partial.model_rev ?? getModelRev() + 1,
		id_map: {},
		changed_elements: [],
		changed_relationships: [],
		deleted_element_ids: [],
		deleted_relationship_ids: [],
		issues_removed_owner_ids: [],
		issues_added: [],
		issue_counts: {},
		...partial
	};
}

beforeAll(() => {
	server.listen({ onUnhandledRequest: 'error' });
	setModelApiConfig({ baseUrl: BASE });
});
afterEach(() => {
	server.resetHandlers();
});
afterAll(() => {
	setModelApiConfig(undefined);
	server.close();
});
beforeEach(() => {
	resetModelStore();
});

describe('tree-items cache', () => {
	it('seedTreeItems upserts and clears missing', () => {
		seedTreeItems([{ id: 'a', type_name: 'T', display_name: 'A', child_count: 0 }]);
		expect(getCachedTreeItems().get('a')?.display_name).toBe('A');
	});

	it('ensureTreeItems fetches uncached ids and records omitted as missing', async () => {
		const bodies: string[][] = [];
		server.use(
			http.post(`${BASE}/model/elements/tree-items`, async ({ request }) => {
				const { ids } = (await request.json()) as { ids: string[] };
				bodies.push(ids);
				// omit 'gone' -> server drops it (does not exist)
				return HttpResponse.json({
					items: ids
						.filter((id) => id !== 'gone')
						.map((id) => ({ id, type_name: 'T', display_name: id.toUpperCase(), child_count: 0 }))
				});
			})
		);

		await ensureTreeItems(['a', 'gone']);

		expect(getCachedTreeItems().has('a')).toBe(true);
		expect(getCachedTreeItems().get('a')?.display_name).toBe('A');
		expect(getMissingElementIds().has('gone')).toBe(true);

		// a second pass must not re-request the known-missing id or the cached one
		await ensureTreeItems(['a', 'gone', 'b']);
		expect(bodies).toEqual([['a', 'gone'], ['b']]);
	});

	it('skips ids already in the full _elements cache', async () => {
		let requested: string[] = [];
		server.use(
			http.post(`${BASE}/model/elements/tree-items`, async ({ request }) => {
				const { ids } = (await request.json()) as { ids: string[] };
				requested = ids;
				return HttpResponse.json({
					items: ids.map((id) => ({ id, type_name: 'T', display_name: id, child_count: 0 }))
				});
			})
		);

		seedElements([{ id: 'full', type_name: 'U', properties: {}, rev: 1 }]);

		await ensureTreeItems(['full', 'x']);

		expect(requested).toEqual(['x']);
		expect(getCachedTreeItems().has('full')).toBe(false);
	});
});

describe('getTreeElements merged map', () => {
	it('getTreeElements prefers full elements, synthesizes name from lite items', () => {
		seedTreeItems([{ id: 'lite', type_name: 'T', display_name: 'LiteName', child_count: 2 }]);
		seedElements([{ id: 'full', type_name: 'U', properties: { name: 'FullName' }, rev: 1 }]);
		const m = getTreeElements();
		expect(m.get('lite')?.properties.name).toBe('LiteName');
		expect(m.get('lite')?.type_name).toBe('T');
		expect(m.get('full')?.properties.name).toBe('FullName');
	});

	it('a display_name equal to the id synthesizes no name property', () => {
		seedTreeItems([{ id: 'x', type_name: 'T', display_name: 'x', child_count: 0 }]);
		expect(getTreeElements().get('x')?.properties.name).toBeUndefined();
	});

	it('full element wins over a lite item with the same id', () => {
		seedTreeItems([{ id: 'dup', type_name: 'LITE', display_name: 'lite', child_count: 0 }]);
		seedElements([{ id: 'dup', type_name: 'FULL', properties: { name: 'full' }, rev: 1 }]);
		const e = getTreeElements().get('dup');
		expect(e?.type_name).toBe('FULL');
		expect(e?.properties.name).toBe('full');
	});

	it('deleting an element via delta evicts its lite entry', () => {
		seedTreeItems([{ id: 'gone', type_name: 'T', display_name: 'G', child_count: 0 }]);
		applyDelta(delta({ model_rev: 1, deleted_element_ids: ['gone'] }));
		expect(getCachedTreeItems().has('gone')).toBe(false);
	});

	it('a temp->canonical remap evicts the temp id lite entry', () => {
		seedTreeItems([{ id: 'tmp_1', type_name: 'T', display_name: 'temp', child_count: 0 }]);
		applyDelta(
			delta({
				model_rev: 1,
				id_map: { tmp_1: 'canon' },
				changed_elements: [{ id: 'canon', type_name: 'T', properties: {}, rev: 1 }]
			})
		);
		expect(getCachedTreeItems().has('tmp_1')).toBe(false);
	});
});
