import { describe, expect, it } from 'vitest';
import {
	appliesPopulation,
	applyBatch,
	DirtyCollector,
	drain,
	expandScope,
	issueListBody,
	LiveIssues,
	Metamodel,
	Model,
	OpError,
	shuffleAdjacency,
	validateBody,
	verifyConsistent,
	type ModelOp,
	type Value,
	type WorkingCopy
} from '../../src/index.ts';
import { loadFixture } from '../golden/load.ts';
import { observe, seededRandom, type StepsFixture } from '../golden/model-steps.ts';
import {
	answered,
	byOwner,
	churnRules,
	classified,
	listedTags,
	sweptFresh
} from '../validation/helpers.ts';
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

	it.each(SEEDS.flatMap((seed) => [[seed, 'both'] as const, [seed, 'working'] as const]))(
		'seed %i, rules swapped %s: coalescing, deltas and unstages keep the state a replay of staged() gives, and the issues a sweep finds',
		(seed, swap) => {
			const random = seededRandom(seed);
			const server = grow(random, 30);
			const wc = workingCopy(clone(server.model), server.rev);
			const variants = churnRules(metamodel);
			const committed = variants.a;
			let working = variants.a;
			const live = new LiveIssues(wc, { rules: { working, committed } });
			drain(live.sweepSteps());
			const mine = new RandomOps(random);
			const peer = new RandomOps(random, 'tmp_peer');
			for (let i = 0; i < 60; i++) {
				shuffleAdjacency(wc.model, random);
				const roll = random();
				try {
					if (roll < 0.1) {
						working = working === variants.a ? variants.b : variants.a;
						live.setRules({ working, committed: swap === 'both' ? working : committed });
					} else if (roll < 0.5) {
						const update = mine.batch(wc.model).find((op) => op.kind === 'update_element');
						if (update !== undefined) live.stage([update], { coalesce: true });
					} else if (roll < 0.68) {
						live.stage(mine.batch(wc.model));
					} else if (roll < 0.86) {
						live.applyDelta(landSome(server, peer).delta);
					} else {
						const staged = wc.staged();
						const ids = [...wc.model.elements()].map((element) => element.id);
						if (random() < 0.5 && staged.length > 0) {
							live.unstage({ batch: staged[Math.floor(random() * staged.length)]!.id });
						} else if (ids.length > 0) {
							live.unstage({ entity: ids[Math.floor(random() * ids.length)]! });
						}
					}
				} catch (caught) {
					if (!(caught instanceof OpError)) throw caught;
				}
				drain(live.sweepSteps());
				expect(live.settled).toBe(true);
				const fresh = workingCopy(clone(server.model), server.rev);
				for (const batch of wc.staged()) fresh.stage(batch.ops);
				const seen = observe(wc.model);
				expect(seen).toEqual(observe(fresh.model));
				verifyConsistent(wc.model);
				expect(byOwner(live.store), `action ${i}`).toEqual(byOwner(sweptFresh(wc, working)));

				// The probe's dirty set: the staged ops as one batch on the committed
				// state, widened by the working rules' reach, and the changed rules'
				// population while the working rules are not the committed ones.
				const oneBatch = workingCopy(clone(server.model), server.rev).model;
				const hooks = new DirtyCollector();
				applyBatch(
					oneBatch,
					wc.staged().flatMap((batch) => batch.ops),
					{ dirty: hooks }
				);
				const expected = new DirtyCollector();
				expected.update(hooks.ids);
				expected.update(expandScope(oneBatch, working, hooks.ids));
				const liveRules = live.rules;
				if (liveRules.working !== liveRules.committed) {
					expected.update(appliesPopulation(wc.model, variants.delta));
				}
				const origins = live.origins();
				expect(origins.hooks, `action ${i}`).toEqual(hooks.ids);
				expect(origins.dirty, `action ${i}`).toEqual(expected.ids);
				// Tagged and resolved as two fresh sweeps, of each state under its rules, say.
				const listed = issueListBody(live);
				expect(
					listed.issues.map((issue) => issue.origin),
					`action ${i}`
				).toEqual(listedTags(listed, server.model, liveRules.committed));
				expect(answered(validateBody(live)), `action ${i}`).toEqual(classified(live, server.model));
				expect(observe(wc.model)).toEqual(seen);
			}
			expect(wc.diverged).toBe(false);
		}
	);

	it.each(SEEDS)('seed %i: adopting staged batches equals restaging them one by one', (seed) => {
		const random = seededRandom(seed);
		const server = grow(random, 30);
		const wc = workingCopy(clone(server.model), server.rev);
		stageSome(wc, new RandomOps(random), random, 10);
		const batches = wc.staged();

		const same = workingCopy(clone(server.model), server.rev);
		expect(same.adoptStaged(batches).conflicts).toEqual([]);
		expect(observe(same.model)).toEqual(observe(wc.model));
		expect(same.staged()).toEqual(batches);

		const peer = new RandomOps(random, 'tmp_peer');
		for (let i = 0; i < 5; i++) landSome(server, peer);
		const adopter = workingCopy(clone(server.model), server.rev);
		const { conflicts } = adopter.adoptStaged(batches);
		const restager = workingCopy(clone(server.model), server.rev);
		const refused = restage(
			restager,
			batches.map((batch) => batch.ops)
		);
		expect(observe(adopter.model)).toEqual(observe(restager.model));
		expect(conflicts.map((conflict) => conflict.batch.id)).toEqual(
			refused.map((i) => batches[i]!.id)
		);
		verifyConsistent(adopter.model);
	});
});

describe('reach through a rebase', () => {
	/**
	 * A part seated on a slot that feeds a coded slot: `seated` holds for `p`,
	 * two hops from `s2`, which no neighbourhood of `s2` names.
	 */
	function seatedChain() {
		const server = new Server(new Model(metamodel));
		const element = (id: string, type_name: string, properties: { [key: string]: Value }) =>
			({ kind: 'create_element', temp_id: `tmp_${id}`, id, type_name, properties }) as ModelOp;
		const rel = (id: string, type_name: string, source_id: string, target_id: string) =>
			({
				kind: 'create_relationship',
				temp_id: `tmp_${id}`,
				id,
				type_name,
				source_id,
				target_id
			}) as ModelOp;
		server.commit([
			element('p', 'Part', { name: 'x' }),
			element('s1', 'Slot', {}),
			element('s2', 'Slot', { code: 1 }),
			rel('seats', 'Seats', 'p', 's1'),
			rel('feeds', 'Feeds', 's1', 's2')
		]);
		const wc = workingCopy(clone(server.model), server.rev);
		const rules = churnRules(metamodel).a;
		const live = new LiveIssues(wc, { rules: { working: rules, committed: rules } });
		drain(live.sweepSteps());
		const seated = () => live.store.issuesOf('p').some((issue) => issue.check === 'rule:seated');
		expect(seated()).toBe(false);
		const fresh = () => byOwner(sweptFresh(wc, rules));
		return { server, live, seated, fresh };
	}

	const uncode: ModelOp = { kind: 'update_element', id: 's2', properties_patch: { code: 0 } };

	it('a delta that moves a property two hops from the owner revalidates the owner', () => {
		const { server, live, seated, fresh } = seatedChain();
		expect(live.applyDelta(server.commit([uncode]).delta).status).toBe('applied');
		expect(seated()).toBe(true);
		expect(byOwner(live.store)).toEqual(fresh());
	});

	it('an unstage that moves a property two hops from the owner revalidates the owner', () => {
		const { live, seated, fresh } = seatedChain();
		live.stage([uncode]);
		expect(seated()).toBe(true);
		live.unstage('all');
		expect(seated()).toBe(false);
		expect(byOwner(live.store)).toEqual(fresh());
	});
});
