import { describe, expect, it, vi } from 'vitest';
import {
	EVALUATIONS,
	Model,
	PyFloat,
	READS,
	type Evaluation,
	type ResolvedArtifact,
	type SearchResultPage,
	type WireElement
} from '../../src/index.ts';
import { family, nodeMetamodel, NODE_DOC } from '../model/fixtures.ts';
import {
	autoHost,
	connect,
	fakeHost,
	openReplica,
	refusal,
	settle,
	type Client
} from './helpers.ts';

const UNSUPPORTED = { status: 501, detail: 'reaches an unsupported pattern' };

async function ready(model = family()) {
	const client = connect();
	await openReplica(client, model, NODE_DOC);
	return client;
}

/** Resolves when the background digest check of the ready replica has ended. */
const verified = (client: Client) =>
	client.nextEvent((event) => event.task === 'verify' && event.done === event.total);

function nodes(count: number): Model {
	const model = new Model(nodeMetamodel());
	for (let i = 0; i < count; i++) {
		model.setProperty(model.createElement('Node', `n${i}`), 'name', `node ${i}`);
	}
	return model;
}

describe('searchModel', () => {
	it('is a method beside the reads', () => {
		expect(Object.keys(EVALUATIONS)).toEqual(['searchModel', 'evaluateNavigation']);
		expect(Object.keys(READS)).not.toContain('searchModel');
	});

	it("answers the fixture model's first page, the route's body in its field order", async () => {
		const client = await ready();
		const page = await client.call<SearchResultPage>('searchModel', {
			target: 'element',
			criteria: [{ type: 'relation_count', op: 'at_least', count: 1, direction: 'outgoing' }],
			limit: 1
		});
		expect(Object.keys(page)).toEqual(['target', 'elements', 'relationships', 'total']);
		expect(page).toEqual({
			target: 'element',
			elements: [{ id: 'a', type_name: 'Node', properties: { name: 'A' }, rev: 1 }],
			relationships: [],
			total: 2
		});
		const rels = await client.call<SearchResultPage>('searchModel', { target: 'relationship' });
		expect(rels.relationships.map((rel) => rel.id)).toEqual(['a-b', 'b-d', 'a-c']);
		expect(rels.total).toBe(3);
	});

	it('refuses malformed params with 422', async () => {
		const client = await ready();
		for (const params of [
			{},
			{ target: 'elements' },
			{ target: 'element', criteria: null },
			{ target: 'element', criteria: [{ type: 'nope' }] },
			{ target: 'element', limit: 501 },
			{ target: 'element', limit: null },
			{ target: 'element', offset: -1 }
		]) {
			expect(await refusal(client.call('searchModel', params))).toMatchObject({ status: 422 });
		}
	});

	it('answers an unsupported pattern with 501, and a read posted after it', async () => {
		const client = await ready();
		const refused = refusal(
			client.call('searchModel', {
				target: 'element',
				criteria: [{ type: 'name_id', field: 'name', op: 'matches', value: '(?x)a' }]
			})
		);
		const after = client.call<WireElement>('getElement', { id: 'b' });
		expect(await refused).toEqual(UNSUPPORTED);
		expect((await after).id).toBe('b');
	});

	it('answers 501 when a subject is too long for the pattern mid-scan, and the next call', async () => {
		const model = family();
		model.setProperty(model.getElement('c'), 'name', 'a'.repeat(1_000_000));
		const client = await ready(model);
		const nested = '('.repeat(64) + 'a' + ')'.repeat(64) + '*$';
		expect(
			await refusal(
				client.call('searchModel', {
					target: 'element',
					criteria: [{ type: 'property', name: 'name', op: 'matches', value: nested }]
				})
			)
		).toEqual(UNSUPPORTED);
		const page = await client.call<SearchResultPage>('searchModel', { target: 'element' });
		expect(page.total).toBe(4);
	});

	it("answers 500 with Python's text for an int float() cannot take", async () => {
		const model = family();
		model.setProperty(model.getElement('d'), 'name', 10n ** 400n);
		const client = await ready(model);
		const gt = { type: 'property', name: 'name', op: 'gt', value: '0' };
		expect(
			await refusal(client.call('searchModel', { target: 'element', criteria: [gt] }))
		).toEqual({ status: 500, detail: 'int too large to convert to float' });
		// Criteria are ANDed in order: an earlier one that fails never reaches it.
		const page = await client.call<SearchResultPage>('searchModel', {
			target: 'element',
			criteria: [{ type: 'name_id', field: 'id', op: 'equals', value: 'a' }, gt]
		});
		expect(page.total).toBe(0);
	});

	it('never answers a cancelled scan, and serves the next request', async () => {
		const host = fakeHost({ tick: 3 });
		host.auto = true;
		const client = connect(host);
		const done = verified(client);
		await openReplica(client, nodes(5_000), NODE_DOC);
		await done;
		await settle();
		host.auto = false;
		let answered = false;
		void client
			.callAs('scan', 'searchModel', { target: 'element', criteria: [{ type: 'orphan' }] })
			.then(() => (answered = true));
		await settle();
		expect(host.waiting).toBe(1);
		client.cancel('scan');
		const next = client.call<WireElement>('getElement', { id: 'n1' });
		host.auto = true;
		host.turn();
		expect((await next).id).toBe('n1');
		await settle();
		expect(answered).toBe(false);
	});

	it('answers a pattern V8 will not compile with 501, never its source', async () => {
		const client = await ready();
		for (const pattern of ['k'.repeat(50_000), '(?i)' + 'k'.repeat(40_000)]) {
			expect(
				await refusal(
					client.call('searchModel', {
						target: 'element',
						criteria: [{ type: 'property', name: 'name', op: 'matches', value: pattern }]
					})
				)
			).toEqual(UNSUPPORTED);
		}
	});

	it('never lets a slice of a 5,000-element scan pass 16 ms, and pages 500 by default', async () => {
		const host = autoHost(1);
		const client = connect(host);
		const done = verified(client);
		await openReplica(client, nodes(5_000), NODE_DOC);
		await done;
		host.slices.length = 0;
		const page = await client.call<SearchResultPage>('searchModel', {
			target: 'element',
			criteria: [{ type: 'property', name: 'name', op: 'contains', value: '9' }]
		});
		expect(page.total).toBe(1_355);
		const matching = Array.from({ length: 5_000 }, (_, i) => i).filter((i) => `${i}`.includes('9'));
		expect(page.elements.map((element) => element.id)).toEqual(
			matching.slice(0, 500).map((i) => `n${i}`)
		);
		expect(host.slices.length).toBeGreaterThan(0);
		expect(Math.max(...host.slices)).toBeLessThanOrEqual(16);
	});
});

describe('the artifact context', () => {
	const artifact = (id: string, name: string, payload: object = {}) => ({
		id,
		kind: 'navigation',
		name,
		artifact_rev: 1,
		payload
	});

	/** What each `searchModel` resolved `ids` to, through the context the service handed it. */
	function watch(ids: readonly string[]) {
		const seen: (ResolvedArtifact | null)[][] = [];
		const evaluations = EVALUATIONS as { searchModel: Evaluation };
		const original = evaluations.searchModel;
		const spy = vi.spyOn(evaluations, 'searchModel').mockImplementation((ctx, params) => {
			seen.push(ids.map((id) => ctx.artifacts.resolve(id)));
			return original(ctx, params);
		});
		return { seen, restore: () => spy.mockRestore() };
	}

	const search = (client: Client) =>
		client.call<SearchResultPage>('searchModel', { target: 'element', limit: 1 });

	it('answers null at once while the replica is opening', async () => {
		const client = connect();
		const answer = async () => [
			await client.call('setArtifacts', { artifacts: [artifact('n1', 'One')] }),
			await client.call('putArtifacts', { changed: [artifact('n2', 'Two')], deleted_ids: ['n1'] }),
			await client.call('putArtifacts', {
				changed: [],
				deleted_ids: [],
				staged: [{ op: 'delete', id: 'n2' }]
			}),
			await client.call('setStagedArtifacts', {
				entries: [{ op: 'create', id: 'tmp_x', kind: 'table', name: 'X', payload: {} }]
			})
		];
		expect(await answer()).toEqual([null, null, null, null]);
		await client.call('open', { project_id: 'demo', metamodel: NODE_DOC });
		expect(client.eventsOf('replica').at(-1)).toMatchObject({ state: 'opening' });
		expect(await answer()).toEqual([null, null, null, null]);
	});

	it('reach every evaluation, and survive close and open', async () => {
		const { seen, restore } = watch(['n1', 'n2', 'tmp_a']);
		try {
			const client = connect();
			await client.call('setArtifacts', { artifacts: [artifact('n1', 'One', { v: 1.5 })] });
			await client.call('setStagedArtifacts', {
				entries: [{ op: 'create', id: 'tmp_a', kind: 'navigation', name: 'A', payload: {} }]
			});
			await openReplica(client, family(), NODE_DOC);
			await search(client);
			expect(seen.at(-1)).toEqual([
				{ id: 'n1', kind: 'navigation', name: 'One', payload: { v: new PyFloat(1.5) } },
				null,
				{ id: 'tmp_a', kind: 'navigation', name: 'A', payload: {} }
			]);

			await client.call('putArtifacts', {
				changed: [artifact('n2', 'Two')],
				deleted_ids: ['n1'],
				staged: [{ op: 'update', id: 'n2', name: 'Two, staged' }]
			});
			await client.call('close');
			await openReplica(client, family(), NODE_DOC);
			await search(client);
			expect(seen.at(-1)).toEqual([
				null,
				{ id: 'n2', kind: 'navigation', name: 'Two, staged', payload: {} },
				null
			]);
		} finally {
			restore();
		}
	});

	it('refuses a malformed call with 422 and keeps what it held', async () => {
		const { seen, restore } = watch(['n1', 'n2']);
		try {
			const client = await ready();
			await client.call('setArtifacts', { artifacts: [artifact('n1', 'One')] });
			const good = { changed: [artifact('n2', 'Two')], deleted_ids: ['n1'] };
			for (const [params, detail] of [
				[{ deleted_ids: [] }, 'changed: must be a list'],
				[
					{ ...good, changed: [{ ...artifact('n2', 'Two'), id: 2 }] },
					'changed[0].id: must be a string'
				],
				[{ ...good, deleted_ids: 'n1' }, 'deleted_ids must be a list of strings'],
				[{ ...good, deleted_ids: [1] }, 'deleted_ids must be a list of strings'],
				[{ ...good, staged: [{ op: 'delete' }] }, 'staged[0].id: must be a string'],
				[{ ...good, staged: {} }, 'staged: must be a list']
			] as const) {
				expect(await refusal(client.call('putArtifacts', params))).toEqual({ status: 422, detail });
			}
			expect(
				await refusal(client.call('setArtifacts', { artifacts: [artifact('n2', 'Two'), null] }))
			).toEqual({ status: 422, detail: 'artifacts[1]: must be an object' });
			expect(
				await refusal(
					client.call('setStagedArtifacts', { entries: [{ op: 'delete', id: 'n1' }, 7] })
				)
			).toEqual({ status: 422, detail: 'entries[1]: must be an object' });
			await search(client);
			expect(seen.at(-1)).toEqual([
				{ id: 'n1', kind: 'navigation', name: 'One', payload: {} },
				null
			]);
		} finally {
			restore();
		}
	});
});
