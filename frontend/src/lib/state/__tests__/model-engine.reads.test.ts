import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { server } from '$lib/api/__tests__/server';
import type { FeedEvent } from '$lib/api/feed';
import { OpsResponseSchema } from '$lib/api/types';
import type { ModelOp as EngineOp } from '$engine';
import {
	applyDelta,
	ensureElement,
	ensureElements,
	ensureTreeItems,
	getCachedElements,
	getCachedTreeItems,
	getMissingElementIds,
	adoptSummary,
	getIssueCounts,
	getIssuesByOwner,
	getModelRev,
	getModelSummary,
	getStagedOps,
	getStructureRev
} from '../model.svelte';
import { stagedSettled } from '../model-engine.svelte';
import {
	beginReplicaCommit,
	getStagingSide,
	handReplicaFeed,
	startReplica,
	stopReplica
} from '../replica.svelte';
import { getSelection, select } from '../selection.svelte';
import { getVisitStack, resetInspectionHistory } from '../inspection-history.svelte';
import { engineStore, peerDelta, type EngineStore } from './support/engine-store';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

let store: EngineStore | null = null;

afterEach(() => {
	store?.dispose();
	store = null;
	select(null);
	resetInspectionHistory();
	vi.restoreAllMocks();
});

async function open(): Promise<EngineStore> {
	store = await engineStore();
	return store;
}

/** Everything the engine said has reached the store. */
async function settled(s: EngineStore): Promise<void> {
	await s.sync.settled();
	await stagedSettled();
}

/** Ops both the engine's and the store's op types accept. */
type Rename = { kind: 'update_element'; id: string; properties_patch: { name: string } };
type Create = {
	kind: 'create_element';
	temp_id: string;
	type_name: string;
	properties: { name: string };
};

const rename = (id: string, name: string): Rename => ({
	kind: 'update_element',
	id,
	properties_patch: { name }
});

const CREATE_X: Create = {
	kind: 'create_element',
	temp_id: 'tmp_x',
	type_name: 'Organization',
	properties: { name: 'zed' }
};

function nameOf(id: string): unknown {
	return getCachedElements().get(id)?.properties['name'];
}

/** The params of every `method` call on `spy`, in order. */
function paramsOf(spy: { mock: { calls: unknown[][] } }, method: string): unknown[] {
	return spy.mock.calls.filter(([m]) => m === method).map(([, params]) => params);
}

/** A peer's commit: the feed frame to the replica, the delta to the model store — as the realtime store does. */
function feedPeer(s: EngineStore, ops: readonly EngineOp[]): void {
	const committed = s.project.commit(ops);
	handReplicaFeed(JSON.parse(committed.eventText) as FeedEvent, committed.eventText);
	applyDelta(peerDelta(committed));
}

describe('the engine store reads the replica', () => {
	it('ensureElement reads the replica', async () => {
		const s = await open();
		expect(getStagingSide()).toBe('engine');
		const call = vi.spyOn(s.sync, 'call');

		const e = await ensureElement('e_000002');
		expect(e?.properties['name']).toBe('Organization-002');
		expect(getCachedElements().get('e_000002')).toEqual(e);

		expect(await ensureElement('ghost')).toBeNull();
		expect(getMissingElementIds().has('ghost')).toBe(true);

		// A temp id is a real id to the engine: asked, and a 404 marks it missing.
		expect(await ensureElement('tmp_x')).toBeNull();
		expect(getMissingElementIds().has('tmp_x')).toBe(true);
		expect(paramsOf(call, 'getElement')).toEqual([
			{ id: 'e_000002' },
			{ id: 'ghost' },
			{ id: 'tmp_x' }
		]);
	});

	it('ensureTreeItems and ensureElements fill the caches', async () => {
		const s = await open();
		await s.link.client.call('stage', { ops: [CREATE_X] });
		await settled(s);

		await ensureTreeItems(['tmp_x', 'e_000005', 'ghost']);
		expect(getCachedTreeItems().get('tmp_x')).toMatchObject({
			type_name: 'Organization',
			display_name: 'zed'
		});
		expect(getCachedTreeItems().has('e_000005')).toBe(true);
		expect(getMissingElementIds().has('ghost')).toBe(true);

		await ensureElements(['tmp_x', 'e_000006', 'nobody']);
		expect(nameOf('tmp_x')).toBe('zed');
		expect(getCachedElements().has('e_000006')).toBe(true);
		expect(getMissingElementIds().has('nobody')).toBe(true);
	});
});

describe('the engine store follows the replica', () => {
	it('a peer delta refreshes what is cached', async () => {
		const s = await open();
		await ensureElements(['e_000002', 'e_000004']);
		const call = vi.spyOn(s.sync, 'call');
		const before = getStructureRev();

		feedPeer(s, [rename('e_000002', 'Peer')]);
		// The delta's own upsert, before the engine has said anything.
		expect(nameOf('e_000002')).toBe('Peer');
		await settled(s);

		expect(nameOf('e_000002')).toBe('Peer');
		expect(paramsOf(call, 'getElementsBatch')).toEqual([{ ids: ['e_000002'] }]);
		expect(getStructureRev()).toBe(before);
		expect(getModelRev()).toBe(1);
	});

	it('a peer delete leaves the caches and the tree items; the structure rev moves once', async () => {
		const s = await open();
		await ensureTreeItems(['e_000003']);
		await ensureElements(['e_000003', 'e_000004']);
		expect(getCachedTreeItems().has('e_000003')).toBe(true);
		const before = getStructureRev();

		feedPeer(s, [{ kind: 'delete_element', id: 'e_000003' }]);
		await settled(s);

		expect(getCachedElements().has('e_000003')).toBe(false);
		expect(getCachedTreeItems().has('e_000003')).toBe(false);
		expect(getCachedElements().has('e_000004')).toBe(true);
		expect(getStructureRev()).toBe(before + 1);
	});

	it('a peer delta does not clobber a staged edit', async () => {
		const s = await open();
		await ensureElement('e_000002');
		await s.link.client.call('stage', { ops: [rename('e_000002', 'Staged')] });
		await settled(s);
		expect(nameOf('e_000002')).toBe('Staged');
		expect(getStagedOps()).toEqual([rename('e_000002', 'Staged')]);

		feedPeer(s, [rename('e_000002', 'Peer')]);
		// The delta's upsert skipped the staged id.
		expect(nameOf('e_000002')).toBe('Staged');
		await settled(s);

		// The working copy replayed the batch over the delta, and the re-read says so.
		expect(nameOf('e_000002')).toBe('Staged');
		expect(getModelRev()).toBe(1);
	});

	it('a delta older than what the replica already told the store changes neither rev nor entities', async () => {
		const s = await open();
		await ensureElement('e_000002');
		// A silent commit leaves a gap; the next frame makes the sync read the tail to head.
		s.project.silentCommit([rename('e_000002', 'One')]);
		const second = s.project.commit([rename('e_000002', 'Two')]);
		s.project.commit([rename('e_000002', 'Three')]);
		handReplicaFeed(JSON.parse(second.eventText) as FeedEvent, second.eventText);
		await settled(s);
		expect(getModelRev()).toBe(3);
		expect(nameOf('e_000002')).toBe('Three');
		adoptSummary({
			model_rev: 3,
			element_count: 0,
			relationship_count: 0,
			elements_by_type: {},
			issue_counts: {},
			undo_depth: 0
		});

		// The realtime store's delta for the frame the replica has gone past.
		const issue = {
			severity: 'error' as const,
			message: 'late issue',
			target_ids: ['e_000002'],
			check: 'rule:x',
			origin: 'on_server' as const
		};
		applyDelta({
			...peerDelta(second),
			issues_added: [issue],
			issue_counts: { error: 1 }
		});

		expect(getModelRev()).toBe(3);
		expect(getModelSummary()?.model_rev).toBe(3);
		expect(nameOf('e_000002')).toBe('Three');
		// Issues are the server's, not the replica's: they still land.
		expect(getIssuesByOwner().get('e_000002')).toEqual([issue]);
		expect(getIssueCounts()).toEqual({ error: 1 });
		expect(getModelSummary()?.issue_counts).toEqual({ error: 1 });
	});

	it('the structure rev follows changed.structural', async () => {
		const s = await open();
		const before = getStructureRev();

		await s.link.client.call('stage', { ops: [CREATE_X] });
		await settled(s);
		expect(getStructureRev()).toBe(before + 1);

		await s.link.client.call('stage', { ops: [rename('e_000002', 'Quiet')] });
		await settled(s);
		expect(getStructureRev()).toBe(before + 1);
	});

	it('an own delta re-keys the caches and re-points selection', async () => {
		const s = await open();
		await s.link.client.call('stage', { ops: [CREATE_X] });
		await settled(s);
		expect(await ensureElement('tmp_x')).not.toBeNull();
		select({ kind: 'element', id: 'e_000001' });
		select({ kind: 'element', id: 'tmp_x' });
		expect(getStagedOps()).toEqual([CREATE_X]);

		const flight = beginReplicaCommit();
		const committed = s.project.commit([CREATE_X]);
		const response = OpsResponseSchema.parse(JSON.parse(committed.responseText));
		expect(response.id_map).toEqual({ tmp_x: 'srv-1' });
		flight.settle({
			text: committed.responseText,
			rev: s.project.rev,
			applied: true,
			rebound: false,
			idMap: response.id_map,
			batchIds: [1]
		});
		applyDelta(response);
		// Re-keyed by the delta itself, before the engine has said anything.
		expect(getCachedElements().has('tmp_x')).toBe(false);
		expect(getSelection()).toEqual({ kind: 'element', id: 'srv-1' });
		await settled(s);

		expect(getCachedElements().has('srv-1')).toBe(true);
		expect(getCachedElements().has('tmp_x')).toBe(false);
		expect(nameOf('srv-1')).toBe('zed');
		expect(getSelection()).toEqual({ kind: 'element', id: 'srv-1' });
		expect(getVisitStack().map((v) => v.id)).toEqual(['e_000001', 'srv-1']);
		expect(getStagedOps()).toEqual([]);
		expect(getModelRev()).toBe(1);
	});

	it('the handle detaches', async () => {
		const s = await open();
		await ensureElement('e_000002');
		await s.link.client.call('stage', { ops: [rename('e_000002', 'Staged')] });
		await settled(s);
		expect(getStagedOps()).toHaveLength(1);

		stopReplica();
		expect(getStagingSide()).toBe('legacy');

		const ready = s.until((status) => status.phase === 'ready');
		startReplica();
		await ready;
		await settled(s);

		expect(getStagingSide()).toBe('engine');
		expect(getCachedElements().size).toBe(0);
		expect(getStagedOps()).toEqual([]);
	});
});
