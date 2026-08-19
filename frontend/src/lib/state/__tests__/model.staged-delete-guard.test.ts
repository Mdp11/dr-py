// Staged-delete resurrection guard: a staged delete removes an entity from the
// local caches while the SERVER still has it (nothing is committed yet), so
// every read path that can (re)insert server state into the caches must treat
// a staged-deleted id as "locally deleted" — fetching it back would silently
// erase the delete from the staged diff (badge + DiffDrawer) and re-render the
// entity everywhere, while the queued delete op still commits. Regression
// tests for that exact bug (delete -> validate -> click referencing element).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';

import type { Element, OpsResponse, Relationship } from '$lib/api/types';
import { server } from '../../api/__tests__/server';
import {
	applyDelta,
	emit,
	ensureElement,
	ensureElements,
	ensureTreeItems,
	getCachedElements,
	getCachedRelationships,
	getCachedTreeItems,
	getMissingElementIds,
	getModelRev,
	getStagedChangeCount,
	getStagedOps,
	resetModelStore,
	seedElements,
	seedRelationships,
	setModelApiConfig
} from '../model.svelte';

const BASE = 'http://api.test/api/v1';

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

function el(id: string, props: Record<string, unknown> = {}, rev = 0): Element {
	return { id, type_name: 'Block', properties: props, rev };
}

function rel(id: string, source: string, target: string, rev = 0): Relationship {
	return { id, type_name: 'Link', source_id: source, target_id: target, properties: {}, rev };
}

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

/** Seed e1 with one incident relationship and stage its delete: the optimistic
 * cascade removes both from the caches and the staged diff shows 2 deletions. */
function stageDeleteWithCascade(): void {
	seedElements([el('e1', { name: 'victim' }), el('e2', { name: 'referencer' })]);
	seedRelationships([rel('r1', 'e2', 'e1')]);
	emit({ kind: 'delete_element', id: 'e1' });
	expect(getCachedElements().has('e1')).toBe(false);
	expect(getCachedRelationships().has('r1')).toBe(false);
	expect(getStagedChangeCount()).toBe(2);
}

describe('ensureElement vs staged delete', () => {
	it('resolves null without fetching, leaving the staged diff intact', async () => {
		let fetches = 0;
		server.use(
			http.get(`${BASE}/model/elements/:id`, ({ params }) => {
				fetches++;
				return HttpResponse.json(el(params.id as string));
			})
		);
		stageDeleteWithCascade();

		// The bug's trigger: any read of the deleted id (Inspector selection,
		// relationship-endpoint name fetch, element-ref picker) after the delete.
		const res = await ensureElement('e1');

		expect(res).toBeNull();
		expect(fetches).toBe(0);
		expect(getCachedElements().has('e1')).toBe(false);
		// The delete rows survive: 8 changes must not become 7.
		expect(getStagedChangeCount()).toBe(2);
		// The queued op is untouched either way; the diff must agree with it.
		expect(getStagedOps()).toEqual([{ kind: 'delete_element', id: 'e1' }]);
		// Locally deleted is NOT server-confirmed-missing.
		expect(getMissingElementIds().has('e1')).toBe(false);
	});

	it('does not cache the response when the delete is staged mid-flight', async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((r) => (release = r));
		server.use(
			http.get(`${BASE}/model/elements/:id`, async ({ params }) => {
				await gate;
				return HttpResponse.json(el(params.id as string));
			})
		);

		const p = ensureElement('e1'); // uncached -> fetch goes out
		emit({ kind: 'delete_element', id: 'e1' }); // staged while in flight
		release!();

		expect(await p).toBeNull();
		expect(getCachedElements().has('e1')).toBe(false);
	});
});

describe('ensureElements / ensureTreeItems vs staged delete', () => {
	it('ensureElements never requests or caches a staged-deleted id', async () => {
		const bodies: string[][] = [];
		server.use(
			http.post(`${BASE}/model/elements/batch`, async ({ request }) => {
				const { ids } = (await request.json()) as { ids: string[] };
				bodies.push(ids);
				return HttpResponse.json({ items: ids.map((id) => el(id)) });
			})
		);
		stageDeleteWithCascade();

		await ensureElements(['e1', 'b']);

		expect(bodies).toEqual([['b']]);
		expect(getCachedElements().has('e1')).toBe(false);
		expect(getMissingElementIds().has('e1')).toBe(false);
		expect(getStagedChangeCount()).toBe(2);
	});

	it('ensureTreeItems never requests or caches a staged-deleted id', async () => {
		const bodies: string[][] = [];
		server.use(
			http.post(`${BASE}/model/elements/tree-items`, async ({ request }) => {
				const { ids } = (await request.json()) as { ids: string[] };
				bodies.push(ids);
				return HttpResponse.json({
					items: ids.map((id) => ({ id, type_name: 'T', display_name: id, child_count: 0 }))
				});
			})
		);
		stageDeleteWithCascade();

		await ensureTreeItems(['e1', 'b']);

		expect(bodies).toEqual([['b']]);
		expect(getCachedTreeItems().has('e1')).toBe(false);
	});
});

describe('cascade-deleted relationships (journal-only, no queued op of their own)', () => {
	it('seedRelationships does not resurrect a cascade-deleted relationship', () => {
		stageDeleteWithCascade();

		// A fresh incident-relationship page read (RelationshipsList) still
		// contains r1 server-side.
		seedRelationships([rel('r1', 'e2', 'e1', 1)]);

		expect(getCachedRelationships().has('r1')).toBe(false);
		expect(getStagedChangeCount()).toBe(2);
	});

	it('applyDelta (peer commit) does not resurrect a cascade-deleted relationship', () => {
		stageDeleteWithCascade();

		applyDelta(delta({ changed_relationships: [rel('r1', 'e2', 'e1', 2)] }));

		expect(getCachedRelationships().has('r1')).toBe(false);
		expect(getStagedChangeCount()).toBe(2);
	});
});
