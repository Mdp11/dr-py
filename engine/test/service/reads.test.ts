import { describe, expect, it } from 'vitest';
import {
	READS,
	type ElementPage,
	type ModelOp,
	type ModelSummary,
	type TreeItemPage,
	type WireElement
} from '../../src/index.ts';
import { family, NODE_DOC } from '../model/fixtures.ts';
import { connect, openReplica, refusal, smartCity } from './helpers.ts';

const rename = (id: string, name: string): ModelOp => ({
	kind: 'update_element',
	id,
	properties_patch: { name }
});

async function ready(rev = 0) {
	const client = connect();
	await openReplica(client, family(), NODE_DOC, { rev });
	return client;
}

describe('every read', () => {
	it('reaches its read', async () => {
		const client = connect();
		const { model, doc } = smartCity();
		await openReplica(client, model, doc);
		const params: { [method: string]: object } = {
			getElement: { id: 'e_000001' },
			getElementsBatch: { ids: ['e_000001', 'e_000002'] },
			listElementsPage: { limit: 3 },
			listElementRelationships: { id: 'e_000001' },
			getModelSummary: {},
			getTreeItemsBatch: { ids: ['e_000001'] },
			listContainmentRoots: { limit: 3 },
			listExcludedRoots: { limit: 3 },
			listContainmentChildren: { id: 'e_000001' }
		};
		expect(Object.keys(READS).sort()).toEqual(Object.keys(params).sort());
		const answers = await Promise.all(
			Object.entries(params).map(([method, p]) => client.call<object>(method, p))
		);
		const shapes = answers.map((answer) => Object.keys(answer));
		expect(shapes).toEqual([
			['id', 'type_name', 'properties', 'rev'],
			['items'],
			['items', 'total'],
			['items', 'total'],
			[
				'model_rev',
				'element_count',
				'relationship_count',
				'elements_by_type',
				'issue_counts',
				'undo_depth'
			],
			['items'],
			['items', 'total'],
			['items', 'total'],
			['items', 'total']
		]);
		expect(
			(await client.call<ElementPage>('listElementsPage', { q: 'organization', limit: 2 })).items
		).toHaveLength(2);
	});

	it('takes the route defaults and refuses a page out of bounds', async () => {
		const client = await ready();
		expect((await client.call<ElementPage>('listElementsPage')).items).toHaveLength(4);
		for (const page of [{ limit: 0 }, { limit: 501 }, { offset: -1 }]) {
			expect(await refusal(client.call('listElementsPage', page))).toMatchObject({ status: 422 });
		}
	});

	it("refuses an unknown element and too many ids in the server's words", async () => {
		const client = await ready();
		expect(await refusal(client.call('getElement', { id: 'ghost' }))).toEqual({
			status: 404,
			detail: "No element with id 'ghost"
		});
		expect(
			await refusal(client.call('getElementsBatch', { ids: Array<string>(501).fill('a') }))
		).toEqual({ status: 422, detail: 'too many ids: 501 (max 500)' });
	});
});

describe('view placements', () => {
	it('narrow the excluded pool until dropped, and survive a new replica', async () => {
		const client = await ready();
		const pool = async (view_id?: string) =>
			(await client.call<TreeItemPage>('listExcludedRoots', { view_id })).items.map(
				(item) => item.id
			);
		expect(await pool()).toEqual(['a', 'c']);
		expect(await client.call('setViewPlacement', { view_id: 'v', element_ids: ['a', 'b'] })).toBe(
			null
		);
		expect(await pool('v')).toEqual(['c']);
		expect(await pool('other')).toEqual(['a', 'c']);
		await client.call('close');
		await openReplica(client, family(), NODE_DOC);
		expect(await pool('v')).toEqual(['c']);
		expect(await client.call('dropViewPlacement', { view_id: 'v' })).toBe(null);
		expect(await pool('v')).toEqual(['a', 'c']);
		expect(
			await refusal(client.call('setViewPlacement', { view_id: 'v', element_ids: 'a' }))
		).toMatchObject({ status: 422 });
	});
});

describe('what reads see', () => {
	it('the summary: the committed rev, and counts that include what is staged', async () => {
		const client = await ready(7);
		await client.call('stage', {
			ops: [{ kind: 'create_element', temp_id: 'tmp_e', type_name: 'Node', properties: {} }]
		});
		expect(await client.call<ModelSummary>('getModelSummary')).toEqual({
			model_rev: 7,
			element_count: 5,
			relationship_count: 3,
			elements_by_type: { Node: 5 },
			issue_counts: null,
			undo_depth: 0
		});
	});

	it('the working copy: a staged rename, a staged delete, a staged create', async () => {
		const client = await ready();
		await client.call('stage', { ops: [rename('c', 'zebra crossing')] });
		await client.call('stage', { ops: [{ kind: 'delete_element', id: 'b' }] });
		await client.call('stage', {
			ops: [{ kind: 'create_element', temp_id: 'tmp_e', type_name: 'Node', properties: {} }]
		});
		const found = await client.call<ElementPage>('listElementsPage', { q: 'zebra' });
		expect(found.items.map((item) => item.id)).toEqual(['c']);
		const children = await client.call<TreeItemPage>('listContainmentChildren', { id: 'a' });
		expect(children.items).toEqual([]);
		expect(await client.call<WireElement>('getElement', { id: 'tmp_e' })).toMatchObject({
			id: 'tmp_e'
		});
		const roots = await client.call<TreeItemPage>('listContainmentRoots');
		expect(roots.items.map((item) => item.id)).toEqual(['a', 'tmp_e', 'c']);
	});
});
