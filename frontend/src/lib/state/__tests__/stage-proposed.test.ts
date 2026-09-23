import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '$lib/api/__tests__/server';
import { hold, PAGE_ORIGIN } from '$lib/engine/__tests__/support/project-server';
import { stageProposedOps } from '../stage-proposed';
import * as checkout from '../checkout.svelte';
import {
	emit,
	ensureElement,
	ensureElements,
	getCachedElements,
	getCachedTreeItems,
	getModelError,
	getModelRev,
	getStagedBatchIds,
	getStagedOps,
	resetModelStore,
	seedElements,
	seedRelationships,
	stagedSettled
} from '../model.svelte';
import { isTempId, type ModelOp } from '../ops';
import { EL, EL2, REL } from './fixtures';
import { engineStore, type EngineStore } from './support/engine-store';

beforeEach(() => {
	seedElements([EL, EL2]);
	seedRelationships([REL]);
	vi.spyOn(checkout, 'ensureCheckout').mockResolvedValue({ ok: true } as never);
});
afterEach(() => {
	resetModelStore();
	vi.restoreAllMocks();
});

describe('stageProposedOps', () => {
	it('refuses empty and stale batches', async () => {
		expect(await stageProposedOps([], 0)).toEqual({ ok: false, reason: 'empty' });
		const ops = [
			{ kind: 'update_element', id: 'e1', properties_patch: { name: 'X' } }
		] as ModelOp[];
		expect(await stageProposedOps(ops, 99)).toEqual({
			ok: false,
			reason: 'stale'
		});
	});

	it('remaps facade temp ids to fresh client temp ids across the batch', async () => {
		const ops = [
			{
				kind: 'create_element',
				temp_id: 'tmp_1',
				type_name: 'Building',
				properties: { name: 'New B' }
			},
			{ kind: 'create_element', temp_id: 'tmp_2', type_name: 'District', properties: {} },
			{
				kind: 'create_relationship',
				temp_id: 'tmp_3',
				type_name: 'Owns',
				source_id: 'tmp_2',
				target_id: 'tmp_1',
				properties: {}
			}
		] as ModelOp[];
		const res = await stageProposedOps(ops, 0);
		expect(res).toEqual({ ok: true, count: 3 });
		const staged = getStagedOps();
		const [c1, c2, rel] = staged as [
			Extract<(typeof staged)[number], { kind: 'create_element' }>,
			Extract<(typeof staged)[number], { kind: 'create_element' }>,
			Extract<(typeof staged)[number], { kind: 'create_relationship' }>
		];
		expect(c1.temp_id).not.toBe('tmp_1'); // fresh, collision-free
		expect(isTempId(c1.temp_id)).toBe(true);
		expect(rel.source_id).toBe(c2.temp_id);
		expect(rel.target_id).toBe(c1.temp_id);
	});

	it('acquires locks per intent group and stages nothing on refusal', async () => {
		const ensure = vi
			.spyOn(checkout, 'ensureCheckout')
			.mockResolvedValue({ ok: false, reason: 'conflict', conflicts: [] } as never);
		const ops = [
			{ kind: 'update_element', id: 'e1', properties_patch: { name: 'X' } }
		] as ModelOp[];
		const res = await stageProposedOps(ops, 0);
		expect(res).toEqual({ ok: false, reason: 'locks' });
		expect(getStagedOps()).toHaveLength(0);
		expect(ensure).toHaveBeenCalledWith([{ resource_id: 'e1', mode: 'exclusive' }], 'edit');
	});

	it('derives connect + delete lock targets, skipping temp-id endpoints', async () => {
		const ensure = vi.spyOn(checkout, 'ensureCheckout').mockResolvedValue({ ok: true } as never);
		const ops = [
			{ kind: 'create_element', temp_id: 'tmp_1', type_name: 'Building', properties: {} },
			{
				kind: 'create_relationship',
				temp_id: 'tmp_2',
				type_name: 'Owns',
				source_id: 'e1',
				target_id: 'tmp_1',
				properties: {}
			},
			{ kind: 'delete_relationship', id: 'r1' }
		] as ModelOp[];
		const res = await stageProposedOps(ops, 0);
		expect(res.ok).toBe(true);
		const intents = ensure.mock.calls.map(([targets, intent]) => [intent, targets]);
		expect(intents).toContainEqual(['connect', [{ resource_id: 'e1', mode: 'exclusive' }]]);
		// delete_relationship locks its SOURCE element (RelationshipsList pattern)
		expect(intents).toContainEqual(['delete', [{ resource_id: 'e1', mode: 'exclusive' }]]);
	});

	it('applies staged ops optimistically (update visible in cache)', async () => {
		const ops = [
			{ kind: 'update_element', id: 'e1', properties_patch: { name: 'Renamed' } }
		] as ModelOp[];
		await stageProposedOps(ops, 0);
		expect(getCachedElements().get('e1')?.properties.name).toBe('Renamed');
	});

	it('remaps id on update/delete ops that reference a same-batch temp id', async () => {
		// The facade emits `el.set(...)` on a just-created element as
		// update_element{id: "tmp_N"} — same tmp_ prefix as the create's
		// temp_id. Every id-bearing op must go through the same remap as
		// temp_id/source_id/target_id, or the staged op dangles.
		const ops = [
			{
				kind: 'create_element',
				temp_id: 'tmp_1',
				type_name: 'Building',
				properties: { name: 'New B' }
			},
			{ kind: 'update_element', id: 'tmp_1', properties_patch: { name: 'Renamed' } },
			{ kind: 'create_element', temp_id: 'tmp_2', type_name: 'District', properties: {} },
			{ kind: 'delete_element', id: 'tmp_2' },
			{
				kind: 'create_relationship',
				temp_id: 'tmp_3',
				type_name: 'Owns',
				source_id: 'tmp_1',
				target_id: 'e2',
				properties: {}
			},
			{ kind: 'update_relationship', id: 'tmp_3', properties_patch: { note: 'x' } }
		] as ModelOp[];
		const res = await stageProposedOps(ops, 0);
		expect(res).toEqual({ ok: true, count: 6 });

		const staged = getStagedOps();
		const c1 = staged[0] as Extract<(typeof staged)[number], { kind: 'create_element' }>;
		const u1 = staged[1] as Extract<(typeof staged)[number], { kind: 'update_element' }>;
		const c2 = staged[2] as Extract<(typeof staged)[number], { kind: 'create_element' }>;
		const d2 = staged[3] as Extract<(typeof staged)[number], { kind: 'delete_element' }>;
		const relC = staged[4] as Extract<(typeof staged)[number], { kind: 'create_relationship' }>;
		const relU = staged[5] as Extract<(typeof staged)[number], { kind: 'update_relationship' }>;

		expect(u1.id).toBe(c1.temp_id);
		expect(u1.id).not.toBe('tmp_1');
		expect(d2.id).toBe(c2.temp_id);
		expect(d2.id).not.toBe('tmp_2');
		expect(relU.id).toBe(relC.temp_id);
		expect(relU.id).not.toBe('tmp_3');

		// The property patch actually lands on the freshly-created cache entry
		// (proof the id remap, not just the staged-op shape, is fixed).
		expect(getCachedElements().get(c1.temp_id)?.properties.name).toBe('Renamed');
	});

	it('preserves the id hint on create ops through the temp-id remap', async () => {
		const ops = [
			{
				kind: 'create_element',
				temp_id: 'tmp_1',
				id: 'real-1',
				type_name: 'Building',
				properties: {}
			},
			{
				kind: 'create_relationship',
				temp_id: 'tmp_2',
				id: 'real-r',
				type_name: 'Owns',
				source_id: 'tmp_1',
				target_id: 'e2',
				properties: {}
			}
		] as ModelOp[];
		const res = await stageProposedOps(ops, 0);
		expect(res).toEqual({ ok: true, count: 2 });
		const [c, r] = getStagedOps() as [
			Extract<ModelOp, { kind: 'create_element' }>,
			Extract<ModelOp, { kind: 'create_relationship' }>
		];
		expect(isTempId(c.temp_id)).toBe(true);
		expect(c.id).toBe('real-1');
		expect(r.id).toBe('real-r');
		expect(r.source_id).toBe(c.temp_id);
	});

	it('seeds prestate so uncached targets need no fetch', async () => {
		// e9 is NOT in the cache; without prestate ensureElement would hit the
		// (unmocked) API and the stage would fail as 'missing'
		const ops = [
			{ kind: 'update_element', id: 'e9', properties_patch: { name: 'Renamed' } }
		] as ModelOp[];
		const prestate = {
			elements: [{ id: 'e9', type_name: 'Building', properties: { name: 'Old' }, rev: 1 }],
			relationships: []
		};
		const res = await stageProposedOps(ops, 0, prestate);
		expect(res).toEqual({ ok: true, count: 1 });
		expect(getCachedElements().get('e9')?.properties.name).toBe('Renamed');
	});
});

describe('stageProposedOps with staging on the engine', () => {
	beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
	afterAll(() => server.close());

	let store: EngineStore | null = null;
	afterEach(() => {
		store?.dispose();
		store = null;
	});

	async function open(): Promise<EngineStore> {
		store = await engineStore();
		return store;
	}

	async function settled(s: EngineStore): Promise<void> {
		await s.sync.settled();
		await stagedSettled();
	}

	it('stages the whole list as one batch, id hints kept', async () => {
		const s = await open();
		const call = vi.spyOn(s.sync, 'call');
		const ops: ModelOp[] = [
			{
				kind: 'create_element',
				temp_id: 'tmp_1',
				id: 'org-hint',
				type_name: 'Organization',
				properties: { name: 'Hinted' }
			},
			{ kind: 'update_element', id: 'e_000002', properties_patch: { name: 'Renamed' } },
			{ kind: 'delete_element', id: 'e_000003' }
		];

		const res = await stageProposedOps(ops, getModelRev());
		expect(res).toEqual({ ok: true, count: 3 });
		await settled(s);

		const stages = call.mock.calls.filter(([method]) => method === 'stage');
		expect(stages).toHaveLength(1);
		const sent = (stages[0]![1] as { ops: ModelOp[] }).ops;
		expect(sent.map((op) => op.kind)).toEqual([
			'create_element',
			'update_element',
			'delete_element'
		]);
		const created = sent[0] as Extract<ModelOp, { kind: 'create_element' }>;
		expect(created.id).toBe('org-hint');
		expect(isTempId(created.temp_id)).toBe(true);
		expect(created.temp_id).not.toBe('tmp_1');
		expect(getStagedBatchIds()).toEqual([1]);
		expect(getStagedOps()).toEqual(sent);
		expect(getCachedElements().get('org-hint')?.properties['name']).toBe('Hinted');
		expect(getCachedElements().get('e_000002')?.properties['name']).toBe('Renamed');
		expect(getCachedElements().has('e_000003')).toBe(false);
	});

	it('a refused list stages nothing and gives every entity back', async () => {
		const s = await open();
		await ensureElements(['e_000002', 'e_000003']);
		const before2 = getCachedElements().get('e_000002');
		const before3 = getCachedElements().get('e_000003');

		const res = await stageProposedOps(
			[
				{
					kind: 'create_element',
					temp_id: 'tmp_1',
					type_name: 'Organization',
					properties: { name: 'Never' }
				},
				{ kind: 'update_element', id: 'e_000002', properties_patch: { name: 'Gone' } },
				{ kind: 'delete_element', id: 'e_000003' },
				{ kind: 'update_element', id: 'e_000002', properties_patch: { nope: 1 } }
			],
			getModelRev()
		);
		// `emit` answers nothing on either side: the refusal is the store's error.
		expect(res).toEqual({ ok: true, count: 4 });
		await settled(s);

		expect(getStagedOps()).toEqual([]);
		expect(getStagedBatchIds()).toEqual([]);
		expect(getCachedElements().get('e_000002')).toEqual(before2);
		expect(getCachedElements().get('e_000003')).toEqual(before3);
		expect([...getCachedElements().keys()].filter(isTempId)).toEqual([]);
		expect([...getCachedTreeItems().keys()].filter(isTempId)).toEqual([]);
		expect(getModelError()?.kind).toBe('rejected');
	});

	it('a proposal staged while a commit is in flight waits for it, and is not merged into its batch', async () => {
		const s = await open();
		const held = hold();
		const committed: unknown[] = [];
		server.use(
			http.post(`${PAGE_ORIGIN}/api/v1/projects/p/commits`, async ({ request }) => {
				const body = (await request.json()) as { ops: never[] };
				committed.push(body.ops);
				await held.arrive();
				const text = s.project.commit(body.ops).responseText;
				return new HttpResponse(text.slice(0, -1) + ',"commit_id":"c-1"}', {
					headers: { 'Content-Type': 'application/json' }
				});
			})
		);
		await ensureElement('e_000002');
		const rename = (name: string): ModelOp => ({
			kind: 'update_element',
			id: 'e_000002',
			properties_patch: { name }
		});
		emit(rename('Quartz'));
		const committing = checkout.commitStaged('m', false);
		await held.reached;
		const call = vi.spyOn(s.sync, 'call');

		// One update, which the engine would merge into the batch being committed.
		const staging = stageProposedOps([rename('Quartzite')], getModelRev());
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(call.mock.calls.filter(([method]) => method === 'stage')).toEqual([]);

		held.release();
		await committing;
		expect(await staging).toEqual({ ok: true, count: 1 });
		await settled(s);

		expect(committed).toEqual([[rename('Quartz')]]);
		expect(getStagedOps()).toEqual([rename('Quartzite')]);
		expect(getStagedBatchIds()).toEqual([2]);
		expect(getCachedElements().get('e_000002')?.properties['name']).toBe('Quartzite');
	});
});
