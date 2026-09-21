import { describe, expect, it } from 'vitest';
import type { ModelOp, StageResult, WireElement } from '../../src/index.ts';
import { family, NODE_DOC, nodeMetamodel } from '../model/fixtures.ts';
import { clone, Server } from '../working/helpers.ts';
import { Model } from '../../src/index.ts';
import { connect, deltaText, openReplica, refusal } from './helpers.ts';

const rename = (id: string, name: string | null): ModelOp => ({
	kind: 'update_element',
	id,
	properties_patch: { name }
});

async function ready(model = family()) {
	const client = connect();
	await openReplica(client, model, NODE_DOC);
	return client;
}

describe('stage', () => {
	it('answers the batch, what changed and its post-state', async () => {
		const client = await ready();
		const result = await client.call<StageResult>('stage', {
			ops: [
				rename('a', 'x'),
				{ kind: 'create_element', temp_id: 'tmp_e', type_name: 'Node', properties: { name: 1.5 } },
				{
					kind: 'create_relationship',
					temp_id: 'tmp_r',
					type_name: 'Refers',
					source_id: 'tmp_e',
					target_id: 'a'
				}
			]
		});
		expect(result).toEqual({
			batch: {
				id: 1,
				ops: [
					rename('a', 'x'),
					{
						kind: 'create_element',
						temp_id: 'tmp_e',
						type_name: 'Node',
						properties: { name: 1.5 }
					},
					{
						kind: 'create_relationship',
						temp_id: 'tmp_r',
						type_name: 'Refers',
						source_id: 'tmp_e',
						target_id: 'a'
					}
				]
			},
			coalesced: false,
			changes: {
				element_ids: ['a', 'tmp_e'],
				relationship_ids: ['tmp_r'],
				deleted_element_ids: [],
				deleted_relationship_ids: [],
				structural: true
			},
			elements: [
				{ id: 'a', type_name: 'Node', properties: { name: 'x' }, rev: 2 },
				{ id: 'tmp_e', type_name: 'Node', properties: { name: 1.5 }, rev: 1 }
			],
			relationships: [
				{
					id: 'tmp_r',
					type_name: 'Refers',
					source_id: 'tmp_e',
					target_id: 'a',
					properties: {},
					rev: 0
				}
			]
		});
	});

	it('answers ids alone past 500 changed entities', async () => {
		const model = new Model(nodeMetamodel());
		for (let i = 0; i < 501; i++) model.createElement('Node', `n${i}`);
		const client = await ready(model);
		const ops = Array.from({ length: 501 }, (_, i) => rename(`n${i}`, 'x'));
		const result = await client.call<StageResult>('stage', { ops });
		expect([result.elements, result.relationships]).toEqual([null, null]);
		expect(result.changes.element_ids).toHaveLength(501);
	});

	it('merges a second single update into the first', async () => {
		const client = await ready();
		const first = await client.call<StageResult>('stage', { ops: [rename('a', 'one')] });
		const second = await client.call<StageResult>('stage', { ops: [rename('a', 'two')] });
		expect([first.batch.id, first.coalesced, second.batch.id, second.coalesced]).toEqual([
			1,
			false,
			1,
			true
		]);
		expect(await client.call('staged')).toEqual([{ id: 1, ops: [rename('a', 'two')] }]);
	});

	it("refuses a batch in the server's words and stages nothing", async () => {
		const client = await ready();
		expect(
			await refusal(client.call('stage', { ops: [rename('a', 'x'), rename('ghost', 'y')] }))
		).toEqual({ status: 422, detail: "No element with id 'ghost" });
		expect(await client.call('staged')).toEqual([]);
		expect(await client.call('getElement', { id: 'a' })).toMatchObject({
			properties: { name: 'A' }
		});
	});

	it('refuses malformed ops before they queue', async () => {
		const client = await ready();
		expect(await refusal(client.call('stage', { ops: [{ kind: 'update_element' }] }))).toEqual({
			status: 422,
			detail: 'ops[0].id: must be a string'
		});
		expect(await refusal(client.call('stage', { ops: 'nope' }))).toEqual({
			status: 422,
			detail: 'ops: must be a list'
		});
	});
});

describe('unstage, conflicts and the diff', () => {
	it('unstages everything, one batch, or one entity', async () => {
		const client = await ready();
		await client.call('stage', { ops: [rename('a', '1'), rename('c', '1')] });
		await client.call('stage', { ops: [{ kind: 'delete_element', id: 'd' }] });
		await client.call('stage', { ops: [rename('b', '3'), rename('c', '3')] });
		const one = await client.call<{ changes: { element_ids: string[] } }>('unstage', {
			what: { entity: 'c' }
		});
		expect(one.changes.element_ids.sort()).toEqual(['a', 'b', 'c']);
		expect(await client.call('staged')).toMatchObject([
			{ id: 1, ops: [rename('a', '1')] },
			{ id: 2 },
			{ id: 3, ops: [rename('b', '3')] }
		]);
		await client.call('unstage', { what: { batch: 2 } });
		expect(await client.call('getElement', { id: 'd' })).toMatchObject({ id: 'd' });
		await client.call('unstage', { what: 'all' });
		expect(await client.call('staged')).toEqual([]);
		expect(await refusal(client.call('unstage', { what: 'some' }))).toMatchObject({ status: 422 });
	});

	it('parks a batch a delta made impossible', async () => {
		const committed = family();
		const server = new Server(clone(committed));
		const client = connect();
		await openReplica(client, committed, NODE_DOC);
		await client.call('stage', { ops: [rename('d', 'doomed')] });
		const { delta } = server.commit([{ kind: 'delete_element', id: 'b' }]);
		await client.call('applyDelta', { text: deltaText(delta) });
		expect(await client.call('conflicts')).toEqual([
			{
				batch: { id: 1, ops: [rename('d', 'doomed')] },
				error: { status: 422, detail: "No element with id 'd" }
			}
		]);
		expect(await client.call('staged')).toEqual([]);
	});

	it('pairs every staged entity with its committed state', async () => {
		const client = await ready();
		await client.call('stage', { ops: [rename('a', 'x'), { kind: 'delete_element', id: 'c' }] });
		expect(await client.call('stagedDiff')).toEqual({
			elements: [
				{
					id: 'a',
					before: { id: 'a', type_name: 'Node', properties: { name: 'A' }, rev: 1 },
					after: { id: 'a', type_name: 'Node', properties: { name: 'x' }, rev: 2 }
				},
				{
					id: 'c',
					before: { id: 'c', type_name: 'Node', properties: { name: 'C' }, rev: 1 },
					after: null
				}
			],
			relationships: [
				{
					id: 'a-c',
					before: {
						id: 'a-c',
						type_name: 'Refers',
						source_id: 'a',
						target_id: 'c',
						properties: {},
						rev: 0
					},
					after: null
				}
			]
		});
	});

	it('answers conflicts and staged in any state, empty without a replica', async () => {
		const client = connect();
		expect(await client.call('conflicts')).toEqual([]);
		expect(await client.call('staged')).toEqual([]);
	});
});

describe('events and copies', () => {
	it('sends a changed event after every transition', async () => {
		const client = await ready();
		await client.call('stage', { ops: [rename('a', 'x')] });
		await client.call('stage', { ops: [{ kind: 'delete_element', id: 'c' }] });
		await client.call('unstage', { what: { batch: 1 } });
		const changed = client.eventsOf('changed');
		expect(changed.map((event) => [event.staged_version, event.structural])).toEqual([
			[1, false],
			[2, true],
			[3, true]
		]);
		expect(changed[0]).toMatchObject({ rev: 0, element_ids: ['a'] });
	});

	it('answers copies: changing a result changes nothing', async () => {
		const client = await ready();
		const element = await client.call<WireElement>('getElement', { id: 'a' });
		element.properties['name'] = 'mutated';
		const staged = await client.call<StageResult>('stage', { ops: [rename('b', 'x')] });
		staged.elements![0]!.properties['name'] = 'mutated too';
		expect(await client.call('getElement', { id: 'a' })).toMatchObject({
			properties: { name: 'A' }
		});
		expect(await client.call('getElement', { id: 'b' })).toMatchObject({
			properties: { name: 'x' }
		});
	});
});
