import { describe, expect, it, vi } from 'vitest';
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
	previewBody,
	RulesValidator,
	rulesStatusBody,
	shuffleAdjacency,
	validateBody,
	verifyConsistent,
	type ModelOp,
	type WorkingCopy
} from '../../src/index.ts';
import { loadFixture } from '../golden/load.ts';
import { observe, seededRandom, type StepsFixture } from '../golden/model-steps.ts';
import { clone, Server, workingCopy } from '../working/helpers.ts';
import { RandomOps } from '../working/random-ops.ts';
import { answered, churnRules, classified, listedTags, sweptFresh, wireKey } from './helpers.ts';

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

/** What `run` returns, and every element a rules validator validated meanwhile. */
function watched<T>(run: () => T): { validated: Set<string> } & T {
	const spy = vi.spyOn(RulesValidator.prototype, 'validateElement');
	try {
		const out = run();
		return { ...out, validated: new Set(spy.mock.calls.map(([, el]) => el.id)) };
	} finally {
		spy.mockRestore();
	}
}

describe('the origin probe with a staged rule set', () => {
	const { a, b, delta } = churnRules(metamodel);

	/**
	 * The scene's replica, or one with nothing staged, once a slot is
	 * committed, under committed rules `a` and working `b`.
	 */
	function staged(seed: number, withEdits: boolean) {
		const { random, server, wc } = scene(seed);
		const { delta } = server.commit([
			{ kind: 'create_element', temp_id: 'tmp_s', type_name: 'Slot', properties: { code: 1 } }
		]);
		if (withEdits) expect(wc.applyDelta(delta).status).toBe('applied');
		const replica = withEdits ? wc : workingCopy(clone(server.model), server.rev);
		const live = new LiveIssues(replica, { rules: { working: b, committed: a } });
		drain(live.sweepSteps());
		shuffleAdjacency(replica.model, random);
		return { server, wc: replica, live };
	}

	it.each(SEEDS.flatMap((seed) => [[seed, true] as const, [seed, false] as const]))(
		'seed %i, staged edits %s: tags and resolves as two fresh sweeps do, and previews on the committed rules',
		(seed, withEdits) => {
			const { server, wc, live } = staged(seed, withEdits);
			expect(wc.staged().length > 0).toBe(withEdits);
			const working = observe(wc.model);
			const before = staging(wc);
			const unchanged = () => {
				expect(observe(wc.model)).toEqual(working);
				expect(staging(wc)).toEqual(before);
				verifyConsistent(wc.model);
			};

			const listed = issueListBody(live);
			unchanged();
			const tags = new Map<string, Set<string>>();
			for (const issue of listed.issues) {
				const seen = tags.get(issue.check) ?? new Set();
				tags.set(issue.check, seen.add(issue.origin));
			}
			// A new rule's issues are the working copy's; an unchanged rule's stand on the server.
			expect(tags.get('rule:owns')).toEqual(new Set(['uncommitted']));
			expect(tags.get('rule:seated')).toContain('on_server');
			expect(listed.rules_status).toEqual(rulesStatusBody(b));
			// The removed rule's issues are resolved.
			const body = validateBody(live);
			unchanged();
			const resolved = body.filter((i) => i.origin === 'resolved').map(wireKey);
			const removed = [...sweptFresh(workingCopy(clone(server.model)), a).iter()]
				.filter((i) => i.check === 'rule:named')
				.map((i) => JSON.stringify([i.severity, i.message, i.targetIds]));
			expect(removed.length).toBeGreaterThan(0);
			for (const key of removed) expect(resolved).toContain(key);
			expect(answered(body)).toEqual(classified(live, server.model));
			expect(listed.issues.map((i) => i.origin)).toEqual(listedTags(listed, server.model, a));

			const previews = [true, false].map((strict) => previewBody(live, strict));
			unchanged();
			const cached = live.origins();
			expect(live.origins()).toBe(cached);
			live.setRules({ working: a, committed: a });
			expect(live.origins()).not.toBe(cached);
			expect([true, false].map((strict) => previewBody(live, strict))).toEqual(previews);
			unchanged();
		}
	);

	it.each(SEEDS)(
		'seed %i: a keystroke revalidates no changed-rule owner the staged edits cannot reach',
		(seed) => {
			// Nothing else staged: every element a changed rule applies to lies outside its reach.
			const { wc, live } = staged(seed, false);
			const tagsOf = () => issueListBody(live).issues.map((i) => `${wireKey(i)} ${i.origin}`);
			// An element of its own, edited last, so that the keystroke dirties it alone.
			live.stage([
				{ kind: 'create_element', temp_id: 'tmp_typing', type_name: 'Part', properties: {} }
			]);
			live.stage([{ kind: 'update_element', id: 'tmp_typing', properties_patch: { name: 't' } }]);
			tagsOf();
			const keystroke: ModelOp = {
				kind: 'update_element',
				id: 'tmp_typing',
				properties_patch: { name: 'typed' }
			};
			expect(live.stage([keystroke], { coalesce: true }).coalesced).toBe(true);

			const { tags, origins, validated } = watched(() => ({
				tags: tagsOf(),
				origins: live.origins()
			}));
			// The model-dirty part: the hooks and what either rule set reaches from them.
			const model = wc.model;
			const reached = new Set([
				...origins.hooks,
				...expandScope(model, b, origins.hooks),
				...expandScope(model, a, origins.hooks)
			]);
			const outside = appliesPopulation(model, delta).filter((id) => !reached.has(id));
			expect(outside.length).toBeGreaterThan(0);
			expect(outside.filter((id) => validated.has(id))).toEqual([]);
			expect(validated.size).toBeGreaterThan(0);

			// With its cache of those owners dropped, the probe finds the same tags.
			live.setRules(live.rules);
			const cleared = watched(() => ({ tags: tagsOf() }));
			expect(cleared.tags).toEqual(tags);
			expect(outside.every((id) => cleared.validated.has(id))).toBe(true);
		}
	);
});
