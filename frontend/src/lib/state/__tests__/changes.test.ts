import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';

import type { ChangesDoc, Element, Relationship } from '$lib/api/types';
import { server } from '../../api/__tests__/server';
import {
	changesDocToDiff,
	clearChangesBadge,
	getChangesBadge,
	getChangesBadgeTotal,
	refreshChangesBadge,
	setChangesApiConfig
} from '../changes.svelte';

const BASE = 'http://api.test/api/v1';

beforeAll(() => {
	server.listen({ onUnhandledRequest: 'error' });
	setChangesApiConfig({ baseUrl: BASE });
});
afterEach(() => server.resetHandlers());
afterAll(() => {
	setChangesApiConfig(undefined);
	server.close();
});
beforeEach(() => clearChangesBadge());

function el(id: string, props: Record<string, unknown> = {}, rev = 0): Element {
	return { id, type_name: 'Block', properties: props, rev };
}

function rl(id: string, source: string, target: string, rev = 0): Relationship {
	return { id, type_name: 'Link', source_id: source, target_id: target, properties: {}, rev };
}

function doc(partial: Partial<ChangesDoc['ops']>): ChangesDoc {
	return {
		format: 'datarover.cr/v1',
		createdAt: '2026-06-12T00:00:00.000Z',
		baseline: { filename: null, elementCount: 0, relationshipCount: 0 },
		ops: {
			elements: { added: [], modified: [], deleted: [] },
			relationships: { added: [], modified: [], deleted: [] },
			...partial
		},
		complete: true
	};
}

describe('changesDocToDiff', () => {
	it('maps added/modified/deleted sections onto EntityDiff rows with counts', () => {
		const before = el('e2', { name: 'old', gone: 1 }, 1);
		const after = el('e2', { name: 'new' }, 2);
		const d = changesDocToDiff(
			doc({
				elements: {
					added: [el('e1', { name: 'A' })],
					modified: [{ id: 'e2', before, after }],
					deleted: [el('e3')]
				},
				relationships: {
					added: [rl('r1', 'e1', 'e2')],
					modified: [],
					deleted: []
				}
			})
		);
		expect(d.counts).toEqual({ added: 2, modified: 1, deleted: 1 });
		expect(d.elements.map((x) => [x.id, x.status])).toEqual([
			['e1', 'added'],
			['e2', 'modified'],
			['e3', 'deleted']
		]);
		const modified = d.elements[1];
		expect(modified.before).toBe(before);
		expect(modified.after).toBe(after);
		expect(modified.modifiedFields?.sort()).toEqual(['gone', 'name']);
		expect(d.relationships).toHaveLength(1);
		expect(d.relationships[0].status).toBe('added');
	});

	it('flags endpoint changes on modified relationships', () => {
		const before = rl('r1', 'a', 'b', 1);
		const after = rl('r1', 'a', 'c', 2);
		const d = changesDocToDiff(
			doc({
				relationships: { added: [], modified: [{ id: 'r1', before, after }], deleted: [] }
			})
		);
		expect(d.relationships[0].modifiedFields).toEqual(['target_id']);
	});

	it('produces an empty diff for an empty change set', () => {
		const d = changesDocToDiff(doc({}));
		expect(d.counts).toEqual({ added: 0, modified: 0, deleted: 0 });
		expect(d.elements).toEqual([]);
		expect(d.relationships).toEqual([]);
	});
});

describe('changes badge', () => {
	it('starts cleared', () => {
		expect(getChangesBadge()).toBeNull();
		expect(getChangesBadgeTotal()).toBe(0);
	});

	it('refreshChangesBadge fetches /model/changes/summary and exposes totals', async () => {
		server.use(
			http.get(`${BASE}/model/changes/summary`, () =>
				HttpResponse.json({
					batches: 3,
					ops: 5,
					adds: 2,
					modifies: 1,
					deletes: 1,
					complete: true
				})
			)
		);
		await refreshChangesBadge();
		expect(getChangesBadge()?.adds).toBe(2);
		expect(getChangesBadgeTotal()).toBe(4);
	});

	it('clearChangesBadge resets to null', async () => {
		server.use(
			http.get(`${BASE}/model/changes/summary`, () =>
				HttpResponse.json({ batches: 1, ops: 1, adds: 1, modifies: 0, deletes: 0, complete: true })
			)
		);
		await refreshChangesBadge();
		expect(getChangesBadgeTotal()).toBe(1);
		clearChangesBadge();
		expect(getChangesBadge()).toBeNull();
		expect(getChangesBadgeTotal()).toBe(0);
	});

	it('keeps the previous badge when the refresh fails', async () => {
		server.use(
			http.get(`${BASE}/model/changes/summary`, () =>
				HttpResponse.json({ batches: 1, ops: 1, adds: 1, modifies: 0, deletes: 0, complete: true })
			)
		);
		await refreshChangesBadge();
		server.use(
			http.get(`${BASE}/model/changes/summary`, () => new HttpResponse(null, { status: 500 }))
		);
		await expect(refreshChangesBadge()).rejects.toThrow();
		expect(getChangesBadgeTotal()).toBe(1);
	});
});
