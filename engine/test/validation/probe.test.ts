import { describe, expect, it } from 'vitest';
import {
	applyBatch,
	DirtyCollector,
	Metamodel,
	Model,
	OpError,
	shuffleAdjacency,
	verifyConsistent,
	type ModelOp,
	type WorkingCopy
} from '../../src/index.ts';
import { loadFixture } from '../golden/load.ts';
import { observe, seededRandom, type StepsFixture } from '../golden/model-steps.ts';
import { clone, Server, workingCopy } from '../working/helpers.ts';
import { RandomOps } from '../working/random-ops.ts';

const metamodel = Metamodel.fromJSON(loadFixture<StepsFixture>('ops_churn').metamodel);

function landSome(server: Server, ops: RandomOps) {
	for (;;) {
		try {
			return server.commit(ops.batch(server.model));
		} catch (caught) {
			if (!(caught instanceof OpError)) throw caught;
		}
	}
}

function tryStage(wc: WorkingCopy, ops: readonly ModelOp[], coalesce = false): boolean {
	try {
		wc.stage(ops, { coalesce });
		return true;
	} catch (caught) {
		if (!(caught instanceof OpError)) throw caught;
		return false;
	}
}

/** Everything the working copy says about its staged state, committed images included. */
function staging(wc: WorkingCopy) {
	const touched = wc.touchedIds();
	return {
		staged: wc.staged(),
		conflicts: wc.conflicts(),
		stagedVersion: wc.stagedVersion,
		touched,
		elements: touched.map((id) => wc.committedElement(id)),
		relationships: touched.map((id) => wc.committedRelationship(id))
	};
}

/**
 * A replica with random staged batches over a grown committed model, among
 * them a cascade delete, a `tmp_` create, a coalesced update and a batch a
 * peer's delta parked.
 */
function scene(seed: number) {
	const random = seededRandom(seed);
	const server = new Server(new Model(metamodel));
	const grow = new RandomOps(random, 'tmp_grow');
	for (let i = 0; i < 30; i++) landSome(server, grow);
	// A container with a child, for the cascade.
	server.commit([
		{ kind: 'create_element', temp_id: 'tmp_boss', id: 'boss', type_name: 'Part', properties: {} },
		{ kind: 'create_element', temp_id: 'tmp_kid', id: 'kid', type_name: 'Part', properties: {} },
		{
			kind: 'create_relationship',
			temp_id: 'tmp_own',
			id: 'own',
			type_name: 'Owns',
			source_id: 'boss',
			target_id: 'kid'
		},
		{
			kind: 'create_element',
			temp_id: 'tmp_doomed',
			id: 'doomed',
			type_name: 'Part',
			properties: {}
		}
	]);
	const wc = workingCopy(clone(server.model), server.rev);
	const mine = new RandomOps(random);
	expect(
		tryStage(wc, [{ kind: 'update_element', id: 'doomed', properties_patch: { name: 'a' } }])
	).toBe(true);
	expect(tryStage(wc, [{ kind: 'delete_element', id: 'boss' }])).toBe(true);
	for (let staged = 0; staged < 4;) if (tryStage(wc, mine.batch(wc.model))) staged++;
	const created = {
		kind: 'create_element',
		temp_id: 'tmp_mine',
		type_name: 'Part',
		properties: {}
	};
	expect(tryStage(wc, [created as ModelOp])).toBe(true);
	// The first staged update of an element that is still there takes the edit.
	const update = wc
		.staged()
		.flatMap((batch) => batch.ops)
		.find((op) => op.kind === 'update_element' && wc.model.findElement(op.id) !== undefined);
	expect(update).toBeDefined();
	const version = wc.stagedVersion;
	expect(
		tryStage(wc, [{ ...update!, properties_patch: { name: 'coalesced' } } as ModelOp], true)
	).toBe(true);
	expect(wc.stagedVersion).not.toBe(version);
	for (let staged = 0; staged < 3;) if (tryStage(wc, mine.batch(wc.model))) staged++;
	// A peer deletes what one batch updates: that batch is parked.
	const { delta } = server.commit([{ kind: 'delete_element', id: 'doomed' }]);
	expect(wc.applyDelta(delta).status).toBe('applied');
	expect(wc.conflicts().length).toBeGreaterThan(0);
	return { random, server, wc, mine };
}

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

describe('the origin probe', () => {
	it.each(SEEDS)('seed %i: leaves no trace', (seed) => {
		const { random, server, wc } = scene(seed);
		shuffleAdjacency(wc.model, random);
		const working = observe(wc.model);
		const before = staging(wc);
		const probe = wc.probeStaged(
			() => observe(wc.model),
			() => observe(wc.model)
		);
		// The callbacks see the working state, then the committed one.
		expect(probe.working).toEqual(working);
		expect(probe.committed).toEqual(observe(server.model));
		expect(observe(wc.model)).toEqual(working);
		expect(staging(wc)).toEqual(before);
		expect(wc.staged().every((batch, i) => batch === before.staged[i])).toBe(true);
		verifyConsistent(wc.model);
		expect(wc.verifyDigest()).toBe(true);
	});

	it.each(SEEDS)('seed %i: a following stage behaves as if no probe ran', (seed) => {
		const { random, server, wc, mine } = scene(seed);
		wc.probeStaged(
			() => null,
			() => null
		);
		for (let staged = 0; staged < 2;) if (tryStage(wc, mine.batch(wc.model))) staged++;
		const fresh = workingCopy(clone(server.model), server.rev);
		for (const batch of wc.staged()) fresh.stage(batch.ops);
		shuffleAdjacency(wc.model, random);
		expect(observe(wc.model)).toEqual(observe(fresh.model));
		verifyConsistent(wc.model);
	});

	it.each(SEEDS)('seed %i: its dirty set is the staged ops applied as one batch', (seed) => {
		const { server, wc } = scene(seed);
		const { dirty } = wc.probeStaged(
			() => null,
			() => null
		);
		const oneBatch = new DirtyCollector();
		applyBatch(
			clone(server.model),
			wc.staged().flatMap((batch) => batch.ops),
			{ dirty: oneBatch }
		);
		expect(dirty).toEqual(oneBatch.ids);
		expect(dirty.length).toBeGreaterThan(0);
	});

	it('is the committed state twice over with nothing staged', () => {
		const server = new Server(new Model(metamodel));
		landSome(server, new RandomOps(seededRandom(9), 'tmp_grow'));
		const wc = workingCopy(clone(server.model), server.rev);
		const probe = wc.probeStaged(
			(dirty) => [...dirty],
			() => observe(wc.model)
		);
		expect(probe).toEqual({ dirty: [], working: [], committed: observe(server.model) });
	});
});
