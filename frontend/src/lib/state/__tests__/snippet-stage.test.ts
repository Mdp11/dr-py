import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stageSnippetOps } from '../snippet-stage';
import * as checkout from '../checkout.svelte';
import {
	getCachedElements,
	getStagedOps,
	resetModelStore,
	seedElements,
	seedRelationships
} from '../model.svelte';
import { isTempId } from '../ops';
import type { SnippetRunOut } from '$lib/api/snippets';

const EL = { id: 'e1', type_name: 'Building', properties: { name: 'Town Hall' }, rev: 1 };
const REL = {
	id: 'r1',
	type_name: 'Owns',
	source_id: 'e1',
	target_id: 'e2',
	properties: {},
	rev: 1
};

function runOut(ops: SnippetRunOut['ops'], overrides: Partial<SnippetRunOut> = {}): SnippetRunOut {
	return {
		run_id: 'r-1',
		stdout: '',
		result_repr: null,
		ops,
		error: null,
		duration_ms: 1,
		model_rev: 0,
		stale: false,
		truncated: false,
		...overrides
	};
}

beforeEach(() => {
	seedElements([EL, { id: 'e2', type_name: 'District', properties: {}, rev: 1 }]);
	seedRelationships([REL]);
	vi.spyOn(checkout, 'ensureCheckout').mockResolvedValue({ ok: true } as never);
});
afterEach(() => {
	resetModelStore();
	vi.restoreAllMocks();
});

describe('stageSnippetOps', () => {
	it('refuses empty and stale batches', async () => {
		expect(await stageSnippetOps(runOut([]))).toEqual({ ok: false, reason: 'empty' });
		const ops = [
			{ kind: 'update_element', id: 'e1', properties_patch: { name: 'X' } }
		] as SnippetRunOut['ops'];
		expect(await stageSnippetOps(runOut(ops, { stale: true }))).toEqual({
			ok: false,
			reason: 'stale'
		});
		expect(await stageSnippetOps(runOut(ops, { model_rev: 99 }))).toEqual({
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
		] as SnippetRunOut['ops'];
		const res = await stageSnippetOps(runOut(ops));
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
		] as SnippetRunOut['ops'];
		const res = await stageSnippetOps(runOut(ops));
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
		] as SnippetRunOut['ops'];
		const res = await stageSnippetOps(runOut(ops));
		expect(res.ok).toBe(true);
		const intents = ensure.mock.calls.map(([targets, intent]) => [intent, targets]);
		expect(intents).toContainEqual(['connect', [{ resource_id: 'e1', mode: 'exclusive' }]]);
		// delete_relationship locks its SOURCE element (RelationshipsList pattern)
		expect(intents).toContainEqual(['delete', [{ resource_id: 'e1', mode: 'exclusive' }]]);
	});

	it('applies staged ops optimistically (update visible in cache)', async () => {
		const ops = [
			{ kind: 'update_element', id: 'e1', properties_patch: { name: 'Renamed' } }
		] as SnippetRunOut['ops'];
		await stageSnippetOps(runOut(ops));
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
		] as SnippetRunOut['ops'];
		const res = await stageSnippetOps(runOut(ops));
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
});
