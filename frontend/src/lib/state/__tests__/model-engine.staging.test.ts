import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { server } from '$lib/api/__tests__/server';
import { getElement } from '$lib/api/elements';
import { NotFoundError } from '$lib/api/errors';
import type { FeedEvent } from '$lib/api/feed';
import { listContainmentRoots, listElementsPage } from '$lib/api/model-read';
import type { Element } from '$lib/api/types';
import type { ModelOp as EngineOp } from '$engine';
import type { Committed } from '$lib/engine/__tests__/support/project-server';
import {
	applyDelta,
	emit,
	emitMany,
	ensureElement,
	ensureElements,
	ensureTreeItems,
	getCachedElements,
	getCachedRelationships,
	getCachedTreeItems,
	getModelError,
	getStagedBatchIds,
	getStagedConflicts,
	getStagedDepth,
	getStagedDiff,
	getStagedNameOverride,
	getStagedOps,
	getStagedOpsFor,
	hasStagedOps,
	isStagedDeleted,
	popLastStaged,
	resetModelStore,
	revertAllStaged,
	revertConflict,
	revertStagedFor,
	revertStagedForElement,
	stagedSettled
} from '../model.svelte';
import type { ModelOp } from '../ops';
import {
	getReplicaStatus,
	handReplicaFeed,
	replicaMetamodelAdopted,
	retryReplica,
	stopReplica
} from '../replica.svelte';
import { engineStore, peerDelta, type EngineStore } from './support/engine-store';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

let store: EngineStore | null = null;

afterEach(() => {
	store?.dispose();
	store = null;
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

const rename = (id: string, name: string): ModelOp => ({
	kind: 'update_element',
	id,
	properties_patch: { name }
});

const create = (tempId: string, name: string): ModelOp => ({
	kind: 'create_element',
	temp_id: tempId,
	type_name: 'Organization',
	properties: { name }
});

const CREATE_X = create('tmp_x', 'zed');

function nameOf(id: string): unknown {
	return getCachedElements().get(id)?.properties['name'];
}

/** A peer's commit: the feed frame to the replica, the delta to the model store. */
function feedPeer(s: EngineStore, ops: readonly EngineOp[]): Committed {
	const committed = s.project.commit(ops);
	handReplicaFeed(JSON.parse(committed.eventText) as FeedEvent, committed.eventText);
	applyDelta(peerDelta(committed));
	return committed;
}

/** The feed frame of `committed`, its state digest flipped: the replica diverges on it. */
function withWrongDigest(committed: Committed): string {
	const digest = committed.delta['state_digest'] as string;
	const wrong = (BigInt('0x' + digest) ^ 1n).toString(16).padStart(16, '0');
	return committed.eventText.replace(`"state_digest":"${digest}"`, `"state_digest":"${wrong}"`);
}

describe('an edit', () => {
	it('an edit is in the cache at once and in the engine after', async () => {
		const s = await open();
		await ensureElement('e_000002');
		const op = rename('e_000002', 'Quartz');

		emit(op);
		expect(nameOf('e_000002')).toBe('Quartz');
		expect(getStagedDepth()).toBe(1);
		await settled(s);

		expect(getStagedOps()).toEqual([op]);
		expect(getStagedBatchIds()).toEqual([1]);
		expect(getStagedDepth()).toBe(1);
		expect(nameOf('e_000002')).toBe('Quartz');
		const page = await listElementsPage({ q: 'Quartz' });
		expect(page.items.map((e) => e.id)).toEqual(['e_000002']);
	});

	it('a create is reachable from the tree', async () => {
		const s = await open();

		emit(CREATE_X);
		expect(getCachedElements().get('tmp_x')).toEqual({
			id: 'tmp_x',
			type_name: 'Organization',
			properties: { name: 'zed' },
			rev: 0
		});
		expect(getCachedTreeItems().get('tmp_x')).toMatchObject({
			type_name: 'Organization',
			display_name: 'zed'
		});
		await settled(s);

		const { total } = await listContainmentRoots({ limit: 1 });
		const last = await listContainmentRoots({ limit: 1, offset: total - 1 });
		expect(last.items.map((t) => t.id)).toEqual(['tmp_x']);
		expect(await ensureElement('tmp_x')).toMatchObject({
			id: 'tmp_x',
			properties: { name: 'zed' }
		});
		expect(getCachedElements().has('tmp_x')).toBe(true);
	});

	it('a delete hides the row', async () => {
		const s = await open();
		await ensureTreeItems(['e_000002']);
		await ensureElement('e_000002');
		expect(getCachedTreeItems().has('e_000002')).toBe(true);

		emit({ kind: 'delete_element', id: 'e_000002' });
		expect(getCachedElements().has('e_000002')).toBe(false);
		expect(getCachedTreeItems().has('e_000002')).toBe(false);
		expect(isStagedDeleted('e_000002')).toBe(true);
		await settled(s);

		// The element, its four children and their thirteen relationships.
		const diff = getStagedDiff();
		expect(diff.elements.filter((e) => e.status === 'deleted')).toHaveLength(5);
		expect(diff.counts.deleted).toBe(18);
		expect(isStagedDeleted('e_000002')).toBe(true);
		await expect(getElement('e_000002')).rejects.toBeInstanceOf(NotFoundError);
	});

	it('keystrokes coalesce and never bounce', async () => {
		const s = await open();
		await ensureElement('e_000002');
		const map = getCachedElements() as Map<string, Element>;
		const written: unknown[] = [];
		const set = map.set.bind(map);
		vi.spyOn(map, 'set').mockImplementation((id, element) => {
			if (id === 'e_000002') written.push(element.properties['name']);
			return set(id, element);
		});
		const deleted = vi.spyOn(map, 'delete');

		emit(rename('e_000002', 'a'));
		emit(rename('e_000002', 'ab'));
		emit(rename('e_000002', 'abc'));
		expect(written).toEqual(['a', 'ab', 'abc']);

		// The cache on every microtask, and between the tasks the engine's messages arrive in.
		const observed: unknown[] = [];
		let done = false;
		const all = settled(s).then(() => (done = true));
		while (!done) {
			for (let i = 0; i < 64 && !done; i++) {
				observed.push(nameOf('e_000002'));
				await Promise.resolve();
			}
			if (!done) await new Promise((resolve) => setTimeout(resolve, 0));
		}
		await all;

		expect(observed.length).toBeGreaterThan(0);
		expect(new Set(observed)).toEqual(new Set(['abc']));
		expect(written.slice(3).every((name) => name === 'abc')).toBe(true);
		expect(deleted.mock.calls.filter(([id]) => id === 'e_000002')).toEqual([]);
		expect(getStagedOps()).toEqual([rename('e_000002', 'abc')]);
		expect(getStagedBatchIds()).toEqual([1]);
		expect(getStagedDepth()).toBe(1);
	});

	it('a refused edit leaves no trace and says so', async () => {
		const s = await open();
		await ensureElement('e_000002');
		const bad: ModelOp = { kind: 'update_element', id: 'e_000002', properties_patch: { nope: 1 } };

		emit(bad);
		expect(getStagedOps()).toEqual([bad]);
		expect(getCachedElements().get('e_000002')?.properties['nope']).toBe(1);
		await settled(s);

		expect(getStagedOps()).toEqual([]);
		expect(getStagedDepth()).toBe(0);
		// The engine's text, quote-stripped as the server's is.
		expect(getModelError()).toEqual({
			kind: 'rejected',
			message: "Organization' has no property 'nope"
		});
		expect(getCachedElements().get('e_000002')).toEqual(await getElement('e_000002'));
		expect(getCachedElements().get('e_000002')?.properties).not.toHaveProperty('nope');

		emit({ kind: 'create_element', temp_id: 'tmp_bad', type_name: 'Nothing', properties: {} });
		expect(getCachedElements().has('tmp_bad')).toBe(true);
		expect(getCachedTreeItems().has('tmp_bad')).toBe(true);
		await settled(s);

		expect(getCachedElements().has('tmp_bad')).toBe(false);
		expect(getCachedTreeItems().has('tmp_bad')).toBe(false);
		expect(getStagedOps()).toEqual([]);
	});

	it('emitMany stages one batch', async () => {
		const s = await open();
		const ops = [create('tmp_m', 'one'), rename('tmp_m', 'two'), rename('tmp_m', 'three')];

		emitMany(ops);
		expect(nameOf('tmp_m')).toBe('three');
		expect(getStagedDepth()).toBe(3);
		await settled(s);

		expect(getStagedBatchIds()).toEqual([1]);
		expect(getStagedOps()).toEqual(ops);
		expect(nameOf('tmp_m')).toBe('three');

		// The last op is refused: nothing of the list stays, and every entity it touched comes back.
		await ensureElements(['e_000002', 'e_000003']);
		const before2 = getCachedElements().get('e_000002');
		const before3 = getCachedElements().get('e_000003');
		emitMany([
			rename('e_000002', 'gone'),
			create('tmp_n', 'never'),
			{ kind: 'delete_element', id: 'e_000003' },
			{ kind: 'update_element', id: 'e_000002', properties_patch: { nope: 1 } }
		]);
		expect(nameOf('e_000002')).toBe('gone');
		expect(getCachedElements().has('e_000003')).toBe(false);
		await settled(s);

		expect(getStagedBatchIds()).toEqual([1]);
		expect(getStagedOps()).toEqual(ops);
		expect(getCachedElements().get('e_000002')).toEqual(before2);
		expect(getCachedElements().get('e_000003')).toEqual(before3);
		expect(getCachedElements().has('tmp_n')).toBe(false);
		expect(getCachedTreeItems().has('tmp_n')).toBe(false);
		expect(getModelError()?.kind).toBe('rejected');
	});
});

describe('the staged readers', () => {
	it('the name override and the ops-for reads', async () => {
		const s = await open();
		const check = () => {
			expect(getStagedNameOverride('e_000002')).toBe('Renamed');
			expect(getStagedNameOverride('e_000004')).toBeUndefined();
			expect(getStagedNameOverride('tmp_x')).toBe('zed');
			expect(getStagedOpsFor('tmp_x')).toEqual([CREATE_X]);
			expect(getStagedOpsFor('e_000002')).toEqual([rename('e_000002', 'Renamed')]);
			expect(hasStagedOps()).toBe(true);
		};

		emit(rename('e_000002', 'Renamed'));
		emit(CREATE_X);
		check();
		await settled(s);
		check();
	});

	it('stagedSettled waits for everything', async () => {
		const s = await open();
		await ensureElement('e_000002');
		const call = vi.spyOn(s.sync, 'call');

		emit(rename('e_000002', 'one'));
		emit(CREATE_X);
		await stagedSettled();

		expect(call.mock.calls.filter(([method]) => method === 'stage')).toHaveLength(2);
		expect(getStagedBatchIds()).toEqual([1, 2]);
		expect(getStagedOps()).toEqual([rename('e_000002', 'one'), CREATE_X]);
		expect(getStagedDepth()).toBe(2);
	});

	it('a detach releases stagedSettled and drops the answers still to come', async () => {
		await open();
		await ensureElement('e_000002');

		emit(rename('e_000002', 'late'));
		expect(popLastStaged()).toBe(true);
		const waiting = stagedSettled();
		stopReplica();
		await waiting;

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(getCachedElements().size).toBe(0);
		expect(getStagedOps()).toEqual([]);
	});
});

describe('the unstage family', () => {
	it('undo removes the last batch', async () => {
		const s = await open();
		await ensureElement('e_000002');

		emit(rename('e_000002', 'one'));
		emit(CREATE_X);
		emit(rename('e_000002', 'two'));
		expect(popLastStaged()).toBe(true);
		await settled(s);

		// The second rename lives in the first batch: undo took the create.
		expect(getStagedBatchIds()).toEqual([1]);
		expect(getStagedOps()).toEqual([rename('e_000002', 'two')]);
		expect(getCachedElements().has('tmp_x')).toBe(false);
		expect(getCachedTreeItems().has('tmp_x')).toBe(false);
		expect(nameOf('e_000002')).toBe('two');

		expect(popLastStaged()).toBe(true);
		await settled(s);
		expect(getStagedOps()).toEqual([]);
		expect(nameOf('e_000002')).toBe('Organization-002');
		expect(popLastStaged()).toBe(false);
	});

	it('revert for an element drops its incident relationship ops', async () => {
		const s = await open();
		await ensureElement('e_000006');
		const connect: ModelOp = {
			kind: 'create_relationship',
			temp_id: 'tmp_r',
			type_name: 'Owns',
			source_id: 'tmp_x',
			target_id: 'e_000006',
			properties: {}
		};

		emit(CREATE_X);
		emit(connect);
		emit(rename('e_000006', 'Team-renamed'));
		expect(getCachedRelationships().has('tmp_r')).toBe(true);
		revertStagedForElement('tmp_x');
		await settled(s);

		expect(getStagedOps()).toEqual([rename('e_000006', 'Team-renamed')]);
		expect(getCachedElements().has('tmp_x')).toBe(false);
		expect(getCachedRelationships().has('tmp_r')).toBe(false);
		expect(nameOf('e_000006')).toBe('Team-renamed');

		revertStagedFor('e_000006');
		await settled(s);
		expect(getStagedOps()).toEqual([]);
		expect(nameOf('e_000006')).toBe('Team-001');

		await ensureElements(['e_000002', 'e_000003']);
		emit(rename('e_000002', 'x'));
		emit({ kind: 'delete_element', id: 'e_000003' });
		emit(CREATE_X);
		revertAllStaged();
		await settled(s);

		expect(getStagedOps()).toEqual([]);
		const cached = new Map(getCachedElements());
		expect(cached.has('tmp_x')).toBe(false);
		resetModelStore();
		await settled(s);
		for (const id of ['e_000002', 'e_000003', 'e_000006']) {
			expect(cached.get(id)).toEqual(await ensureElement(id));
		}
	});

	it("a peer's delete parks a staged update", async () => {
		const s = await open();
		await ensureElements(['e_000003', 'e_000004']);
		const op = rename('e_000003', 'mine');

		emit(op);
		await settled(s);
		feedPeer(s, [{ kind: 'delete_element', id: 'e_000003' }]);
		await settled(s);

		expect(getStagedConflicts()).toEqual([
			{
				batch: { id: 1, ops: [op] },
				error: { status: 422, detail: "No element with id 'e_000003" }
			}
		]);
		expect(getStagedOps()).toEqual([]);
		expect(getStagedBatchIds()).toEqual([]);

		revertStagedForElement('e_000003');
		await settled(s);
		expect(getStagedConflicts()).toEqual([]);

		const other = rename('e_000004', 'mine too');
		emit(other);
		await settled(s);
		feedPeer(s, [{ kind: 'delete_element', id: 'e_000004' }]);
		await settled(s);
		expect(getStagedConflicts()).toEqual([
			{
				batch: { id: 2, ops: [other] },
				error: { status: 422, detail: "No element with id 'e_000004" }
			}
		]);

		revertConflict(2);
		await settled(s);
		expect(getStagedConflicts()).toEqual([]);
		expect(getStagedOps()).toEqual([]);
	});
});

describe('across a re-bootstrap', () => {
	it('edits survive a re-bootstrap', async () => {
		const s = await open();
		await ensureElements(['e_000001', 'e_000002']);
		emit(rename('e_000001', 'staged name'));
		emit(create('tmp_x', 'staged org'));
		await settled(s);
		const ops = getStagedOps();
		const ids = getStagedBatchIds();
		expect(ids).toEqual([1, 2]);

		s.project.fail('snapshot', 503, 99);
		const committed = s.project.commit([rename('e_000002', 'peer')] as EngineOp[]);
		const failed = s.until((status) => status.phase === 'failed');
		const text = withWrongDigest(committed);
		handReplicaFeed(JSON.parse(text) as FeedEvent, text);
		applyDelta(peerDelta(committed));
		await failed;
		await s.sync.settled();

		s.project.fail('snapshot', 503, 0);
		const ready = s.until((status) => status.phase === 'ready');
		retryReplica();
		await ready;
		await settled(s);

		expect(getReplicaStatus()).toMatchObject({ phase: 'ready', rev: s.project.rev });
		expect(getStagedOps()).toEqual(ops);
		expect(getStagedBatchIds()).toEqual(ids);
		expect(nameOf('e_000001')).toBe('staged name');
		expect(nameOf('tmp_x')).toBe('staged org');
		expect(nameOf('e_000002')).toBe('peer');
	});

	it('a batch that parks in a re-bootstrap gives its entities back', async () => {
		const s = await open();
		await ensureElements(['e_000004', 'e_000005']);
		const batch = [rename('e_000004', 'staged four'), rename('e_000005', 'staged five')];
		emitMany(batch);
		await settled(s);
		expect(nameOf('e_000004')).toBe('staged four');

		// A peer deletes one of them where the replica cannot follow: a rev with no journal row.
		s.project.silentCommit([{ kind: 'delete_element', id: 'e_000005' }]);
		s.project.opaqueBump();
		const resyncing = s.until((status) => status.phase === 'resyncing');
		const ready = s.until((status) => status.phase === 'ready');
		handReplicaFeed({ type: 'reset', model_rev: s.project.rev } as FeedEvent, undefined);
		await resyncing;
		await ready;
		await settled(s);

		expect(getStagedOps()).toEqual([]);
		expect(getStagedConflicts()).toEqual([
			{
				batch: { id: 1, ops: batch },
				error: { status: 422, detail: "No element with id 'e_000005" }
			}
		]);
		expect(nameOf('e_000004')).toBe('Organization-004');
		expect(getCachedElements().has('e_000005')).toBe(false);
	});

	it('an edit while frozen lands and is carried', async () => {
		const s = await open();
		await ensureElement('e_000002');
		const frozen = s.until((status) => status.phase === 'frozen');
		handReplicaFeed(
			{
				type: 'rebind',
				rev: s.project.rev + 1,
				from_metamodel_id: 'mm-1',
				to_metamodel_id: 'mm-2',
				validation_error_count: 0
			},
			undefined
		);
		await frozen;

		const op = rename('e_000002', 'while frozen');
		emit(op);
		await settled(s);
		expect(getReplicaStatus().phase).toBe('frozen');
		expect(getStagedOps()).toEqual([op]);

		// The fake's rebind keeps the metamodel document, so the edit still applies.
		s.project.rebind('mm-2');
		const ready = s.until((status) => status.phase === 'ready' && status.rev === s.project.rev);
		replicaMetamodelAdopted();
		await ready;
		await settled(s);

		expect(getStagedOps()).toEqual([op]);
		expect(getStagedConflicts()).toEqual([]);
		expect(nameOf('e_000002')).toBe('while frozen');
	});
});
