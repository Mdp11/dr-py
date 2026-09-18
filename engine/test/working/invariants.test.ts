import { describe, expect, it } from 'vitest';
import {
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
import { clone, Server, workingCopy } from './helpers.ts';
import { RandomOps } from './random-ops.ts';

const metamodel = Metamodel.fromJSON(loadFixture<StepsFixture>('ops_churn').metamodel);

/** A committed model grown by a server landing random batches. */
function grow(random: () => number, batches: number): Server {
	const server = new Server(new Model(metamodel));
	const ops = new RandomOps(random, 'tmp_grow');
	for (let i = 0; i < batches; i++) landSome(server, ops);
	return server;
}

/** Lands the next random batch the server accepts, and returns what it returns. */
function landSome(server: Server, ops: RandomOps) {
	for (;;) {
		try {
			return server.commit(ops.batch(server.model));
		} catch (caught) {
			if (!(caught instanceof OpError)) throw caught;
		}
	}
}

/** Stages `count` random batches; the refused ones leave no trace and are not counted. */
function stageSome(wc: WorkingCopy, ops: RandomOps, random: () => number, count: number): void {
	for (let staged = 0; staged < count;) {
		shuffleAdjacency(wc.model, random);
		try {
			wc.stage(ops.batch(wc.model));
			staged++;
		} catch (caught) {
			if (!(caught instanceof OpError)) throw caught;
		}
		verifyConsistent(wc.model);
	}
}

/** Stages each batch on a replica that never saw the others rebased; the refused ones are the conflicts. */
function restage(wc: WorkingCopy, batches: readonly (readonly ModelOp[])[]): number[] {
	const refused: number[] = [];
	batches.forEach((ops, i) => {
		try {
			wc.stage(ops);
		} catch (caught) {
			if (!(caught instanceof OpError)) throw caught;
			refused.push(i);
		}
	});
	return refused;
}

const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

describe('working-copy invariants over seeded random batches', () => {
	it.each(SEEDS)(
		'seed %i: staging then unstaging everything leaves the committed state',
		(seed) => {
			const random = seededRandom(seed);
			const wc = workingCopy(grow(random, 30).model);
			const committed = observe(wc.model);
			stageSome(wc, new RandomOps(random), random, 25);
			expect(observe(wc.model)).not.toEqual(committed);
			wc.unstage('all');
			expect(observe(wc.model)).toEqual(committed);
			verifyConsistent(wc.model);
		}
	);

	it.each(SEEDS)('seed %i: unstaging one batch equals staging the others afresh', (seed) => {
		const random = seededRandom(seed);
		const committed = grow(random, 30).model;
		const wc = workingCopy(clone(committed));
		stageSome(wc, new RandomOps(random), random, 12);
		const batches = wc.staged();
		const victim = batches[Math.floor(random() * batches.length)]!;
		wc.unstage({ batch: victim.id });

		const fresh = workingCopy(clone(committed));
		const others = batches.filter((batch) => batch !== victim);
		const refused = restage(
			fresh,
			others.map((batch) => batch.ops)
		);
		expect(observe(wc.model)).toEqual(observe(fresh.model));
		expect(wc.conflicts().map((conflict) => conflict.batch.id)).toEqual(
			refused.map((i) => others[i]!.id)
		);
		verifyConsistent(wc.model);
	});

	it.each(SEEDS)('seed %i: a rebase over deltas equals staging on a fresh replica', (seed) => {
		const random = seededRandom(seed);
		const server = grow(random, 30);
		const wc = workingCopy(clone(server.model), server.rev);
		stageSome(wc, new RandomOps(random), random, 10);
		const batches = wc.staged();

		const peer = new RandomOps(random, 'tmp_peer');
		for (let i = 0; i < 5; i++) {
			shuffleAdjacency(wc.model, random);
			expect(wc.applyDelta(landSome(server, peer).delta).status).toBe('applied');
			verifyConsistent(wc.model);
		}
		expect(wc.diverged).toBe(false);

		// Conflicts are parked as they arise, and a parked batch is not retried:
		// a fresh replica must refuse the same batches, given the same survivors.
		const parked = new Set(wc.conflicts().map((conflict) => conflict.batch.id));
		const fresh = workingCopy(clone(server.model), server.rev);
		const survivors = batches.filter((batch) => !parked.has(batch.id));
		expect(
			restage(
				fresh,
				survivors.map((batch) => batch.ops)
			)
		).toEqual([]);
		expect(observe(wc.model)).toEqual(observe(fresh.model));
		expect(wc.digest).toBe(fresh.digest);
	});

	it.each(SEEDS)('seed %i: an own commit lands where the server landed it', (seed) => {
		const random = seededRandom(seed);
		const server = grow(random, 30);
		const wc = workingCopy(clone(server.model), server.rev);
		stageSome(wc, new RandomOps(random), random, 8);
		const batches = wc.staged();
		const cut = 1 + Math.floor(random() * (batches.length - 1));
		const sent = batches.slice(0, cut);

		const { delta, result } = server.commit(sent.flatMap((batch) => batch.ops));
		const { status } = wc.applyDelta(delta, {
			batchIds: sent.map((batch) => batch.id),
			idMap: result.idMap
		});
		expect(status).toBe('applied');
		expect(wc.diverged).toBe(false);
		expect(wc.conflicts()).toEqual([]);

		const rest = wc.staged();
		expect(rest.map((batch) => batch.id)).toEqual(batches.slice(cut).map((batch) => batch.id));
		const fresh = workingCopy(clone(server.model), server.rev);
		expect(
			restage(
				fresh,
				rest.map((batch) => batch.ops)
			)
		).toEqual([]);
		expect(observe(wc.model)).toEqual(observe(fresh.model));
		verifyConsistent(wc.model);
	});
});
