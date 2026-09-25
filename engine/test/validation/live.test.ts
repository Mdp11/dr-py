import { describe, expect, it, vi } from 'vitest';
import {
	applyBatch,
	cmpCodePoint,
	drain,
	FacetPatterns,
	issueKey,
	issueListBody,
	LiveIssues,
	Metamodel,
	Model,
	OpError,
	PatternUnusable,
	previewBody,
	PyFloat,
	RESCAN_STEP,
	RulesValidator,
	shuffleAdjacency,
	validateBody,
	type CompiledRules,
	type ElementRec,
	type MetamodelDoc,
	type ModelOp,
	type RelRec,
	type Value
} from '../../src/index.ts';
import { loadFixture } from '../golden/load.ts';
import { seededRandom, type StepsFixture } from '../golden/model-steps.ts';
import { clone, Server, workingCopy } from '../working/helpers.ts';
import { byOwner, compileSets, sweptFresh, type RuleDoc } from './helpers.ts';

const doc = loadFixture<{ runs: StepsFixture[] }>('validation_steps').runs[0]!.metamodel;
const metamodel = Metamodel.fromJSON(doc);

const BASES = ['Blk', 'Other', 'Car', 'Wheel'];

/**
 * Random batches over the `validation_steps` metamodel, most of which land:
 * values that break a facet, an enum or a multiplicity, references that
 * dangle, duplicates, second parents and cycles, cascades, and elements
 * deleted and created again under their ids.
 */
class Churn {
	private temps = 0;
	private readonly random: () => number;
	private readonly prefix: string;

	constructor(random: () => number, prefix: string) {
		this.random = random;
		this.prefix = prefix;
	}

	private pick<T>(items: readonly T[]): T {
		return items[Math.floor(this.random() * items.length)]!;
	}

	props(type: string, blks: readonly string[]): { [key: string]: Value } {
		const name = `n${Math.floor(this.random() * 30)}`;
		if (type !== 'Blk') return { name };
		const props: { [key: string]: Value } = { name, n: this.pick([1, 3, 9, -1]) };
		if (this.random() < 0.9) props['req'] = 'x';
		if (this.random() < 0.2) props['code'] = this.pick(['AB', 'abcd']);
		if (this.random() < 0.2) props['c'] = this.pick(['red', 'blue']);
		if (this.random() < 0.3) props['ref'] = this.pick([...blks.slice(0, 50), 'nope']);
		return props;
	}

	batch(model: Model): ModelOp[] {
		const all = [...model.elements()];
		const of = (type: string) => all.filter((e) => e.typeName === type).map((e) => e.id);
		const blks = of('Blk');
		const ids = all.map((e) => e.id);
		const rels = [...model.relationships()];
		const ops: ModelOp[] = [];
		const count = 1 + Math.floor(this.random() * 3);
		for (let i = 0; i < count && ids.length > 0; i++) {
			const roll = this.random();
			const id = this.pick(ids);
			const type = model.findElement(id)?.typeName ?? 'Other';
			if (roll < 0.2) {
				const type_name = this.pick(BASES);
				ops.push({
					kind: 'create_element',
					temp_id: `${this.prefix}${++this.temps}`,
					type_name,
					properties: this.props(type_name, blks)
				});
			} else if (roll < 0.5) {
				const patch = this.props(type, blks);
				if (type === 'Blk' && this.random() < 0.3) patch['req'] = null;
				ops.push({ kind: 'update_element', id, properties_patch: patch });
			} else if (roll < 0.7) {
				const [type_name, source_id, target_id] = this.pick([
					['Owns', this.pick(ids), this.pick(ids)],
					['Link', this.pick([...blks, id]), this.pick(ids)],
					['Needs', this.pick(ids), this.pick(ids)]
				] as const);
				const properties: { [key: string]: Value } = type_name === 'Link' ? { lbl: 'l' } : {};
				ops.push({
					kind: 'create_relationship',
					temp_id: `${this.prefix}${++this.temps}`,
					type_name,
					source_id,
					target_id,
					properties
				});
			} else if (roll < 0.8 && rels.length > 0) {
				ops.push({ kind: 'delete_relationship', id: this.pick(rels).id });
			} else if (roll < 0.9) {
				ops.push({ kind: 'delete_element', id });
			} else if (!id.startsWith('tmp_')) {
				ops.push(...recreate(id, type, this.props(type, blks)));
			}
		}
		return ops;
	}
}

/** Deletes an element and creates it again under its id: a new entity, last in state order. */
function recreate(id: string, type: string, properties: { [key: string]: Value }): ModelOp[] {
	return [
		{ kind: 'delete_element', id },
		{ kind: 'create_element', temp_id: `tmp_again_${id}`, id, type_name: type, properties }
	];
}

/** A committed model of `elements` random elements and half as many relationships. */
function grown(random: () => number, elements: number): Model {
	const model = new Model(metamodel);
	const churn = new Churn(random, 'tmp_');
	const ids: string[] = [];
	const blks: string[] = [];
	const ops: ModelOp[] = [];
	for (let i = 1; i <= elements; i++) {
		const id = `e-${i}`;
		const type_name = BASES[Math.min(3, Math.floor(random() * 5))]!;
		ids.push(id);
		if (type_name === 'Blk') blks.push(id);
		ops.push({
			kind: 'create_element',
			temp_id: `tmp_${id}`,
			id,
			type_name,
			properties: churn.props(type_name, blks)
		});
	}
	const pick = (items: readonly string[]) => items[Math.floor(random() * items.length)]!;
	for (let i = 1; i <= elements / 2; i++) {
		const type_name = pick(['Owns', 'Owns', 'Link', 'Needs']);
		ops.push({
			kind: 'create_relationship',
			temp_id: `tmp_r-${i}`,
			id: `r-${i}`,
			type_name,
			source_id: type_name === 'Link' ? pick(blks) : pick(ids),
			target_id: pick(ids),
			properties: type_name === 'Link' ? { lbl: 'l' } : {}
		});
	}
	applyBatch(model, ops);
	return model;
}

function attempt<T>(action: () => T): T | null {
	try {
		return action();
	} catch (caught) {
		if (!(caught instanceof OpError)) throw caught;
		return null;
	}
}

/** Lands the next random batch the server accepts, and returns its delta. */
function peerDelta(server: Server, churn: Churn) {
	for (;;) {
		const landed = attempt(() => server.commit(churn.batch(server.model)));
		if (landed !== null) return landed.delta;
	}
}

describe('an edit during the sweep', () => {
	it.each([1, 2, 3])(
		'seed %i: the finished store is what a fresh sweep of the final state finds',
		(seed) => {
			const random = seededRandom(seed);
			const server = new Server(grown(random, 3000), 1);
			const wc = workingCopy(clone(server.model), server.rev);
			const live = new LiveIssues(wc, { sweepStep: 97 });
			const mine = new Churn(random, 'tmp_mine_');
			const peer = new Churn(random, 'tmp_peer_');
			const listed = [...wc.model.elements()].map((e) => e.id);
			const steps = live.sweepSteps();
			expect(steps.next().value).toEqual({ done: 0, total: 4500 });
			const scripted: ((done: number) => void)[] = [
				// one already swept, edited
				() =>
					live.stage([{ kind: 'update_element', id: listed[0]!, properties_patch: { name: 'z' } }]),
				// one listed and not yet swept, deleted
				(done) => live.stage([{ kind: 'delete_element', id: listed[done + 400]! }]),
				// a new one
				() =>
					live.stage([
						{
							kind: 'create_element',
							temp_id: 'tmp_new',
							id: 'new-1',
							type_name: 'Blk',
							properties: { name: 'n1', n: 9 }
						}
					]),
				// one listed, created again under its id, staged and by a peer
				(done) => {
					const element = listed.slice(done + 500).find((id) => wc.model.findElement(id));
					live.stage(recreate(element!, wc.model.getElement(element!).typeName, { name: 'again' }));
				},
				(done) => {
					const element = listed.slice(done + 600).find((id) => server.model.findElement(id));
					const type = server.model.getElement(element!).typeName;
					live.applyDelta(server.commit(recreate(element!, type, { name: 'again' })).delta);
				}
			];
			for (let k = 0; ; k++) {
				const next = steps.next();
				if (next.done === true) {
					expect(next.value).toBe(true);
					break;
				}
				shuffleAdjacency(wc.model, random);
				const done = next.value.done;
				if (k < scripted.length) {
					scripted[k]!(done);
					continue;
				}
				const roll = random();
				if (roll < 0.35) {
					attempt(() => live.stage(mine.batch(wc.model)));
				} else if (roll < 0.5) {
					const update = mine.batch(wc.model).find((op) => op.kind === 'update_element');
					if (update !== undefined) attempt(() => live.stage([update], { coalesce: true }));
				} else if (roll < 0.65) {
					const staged = wc.staged();
					if (staged.length > 0)
						live.unstage({ batch: staged[Math.floor(random() * staged.length)]!.id });
				} else if (roll < 0.9) {
					live.applyDelta(peerDelta(server, peer));
				} else {
					const sent = wc.staged()[0];
					const landed = sent && attempt(() => server.commit(sent.ops));
					if (sent && landed) {
						live.applyDelta(landed.delta, { batchIds: [sent.id], idMap: landed.result.idMap });
					}
				}
			}
			expect(wc.diverged).toBe(false);
			expect(live.seeded).toBe(true);
			expect(live.store.size).toBeGreaterThan(0);
			expect(byOwner(live.store)).toEqual(byOwner(sweptFresh(wc)));
		}
	);
});

/** Passes `inner`'s entries on, counting each. */
function* counted<T>(inner: Iterator<T>, count: () => void): Generator<T, undefined, void> {
	for (;;) {
		const next = inner.next();
		if (next.done === true) return;
		count();
		yield next.value;
	}
}

/**
 * The entries `model`'s ordered reads hand out while `during` runs: every
 * iterator they return counts, whoever holds it and whenever it is read.
 */
function pullCounter(model: Model) {
	let counting = false;
	let pulled = 0;
	const count = () => {
		if (counting) pulled++;
	};
	const elements = model.elements.bind(model);
	const relationships = model.relationships.bind(model);
	model.elements = () => counted<ElementRec>(elements(), count);
	model.relationships = () => counted<RelRec>(relationships(), count);
	return <T>(during: () => T): [T, number] => {
		counting = true;
		pulled = 0;
		try {
			return [during(), pulled];
		} finally {
			counting = false;
		}
	};
}

describe('the sweep lists in steps', () => {
	it.each([1, 2])(
		'seed %i: across entities restored at their old places and re-sorts, no step pulls more than its share and the store ends as a fresh sweep',
		(seed) => {
			const random = seededRandom(seed);
			const server = new Server(grown(random, 3000), 1);
			const wc = workingCopy(clone(server.model), server.rev);
			const [sweepStep, sweepSkip] = [97, 1000];
			const live = new LiveIssues(wc, { sweepStep, sweepSkip });
			const listed = [...wc.model.elements()].map((e) => e.id);
			const during = pullCounter(wc.model);
			const steps = live.sweepSteps();
			const pulls: number[] = [];
			const reports: number[] = [];
			const epoch = wc.model.orderEpoch;
			let restores = 0;
			let ended = false;
			// A re-sort sends the sweep back over what it has passed, `sweepSkip` a
			// step: bounded, in case one every few steps ever kept it from its end.
			for (let k = 0; k < 1000 && !ended; k++) {
				const [next, pulled] = during(() => steps.next());
				pulls.push(pulled);
				if (next.done === true) {
					expect(next.value).toBe(true);
					ended = true;
					continue;
				}
				reports.push(next.value.done);
				const done = next.value.done;
				const present = (ids: readonly string[]) => ids.find((id) => wc.model.findElement(id));
				if (k % 8 === 1) {
					// one the sweep has passed, deleted with its relationships
					const passed = present(listed.slice(0, done).toReversed());
					if (passed !== undefined) live.stage([{ kind: 'delete_element', id: passed }]);
				} else if (k % 8 === 3) {
					// one it has not reached yet
					const ahead = present(listed.slice(done + 200));
					if (ahead !== undefined) live.stage([{ kind: 'delete_element', id: ahead }]);
				} else if (k % 8 === 7 && wc.staged().length > 0) {
					// both back at their old places; the next ordered reads re-sort
					live.unstage('all');
					restores++;
					expect([...wc.model.elements()]).toHaveLength(wc.model.elementCount);
					expect([...wc.model.relationships()]).toHaveLength(wc.model.relationshipCount);
				} else if (random() < 0.3) {
					attempt(() => live.stage(new Churn(random, `tmp_${k}_`).batch(wc.model)));
				}
			}
			expect(ended).toBe(true);
			expect(restores).toBeGreaterThan(3);
			expect(wc.model.orderEpoch).toBeGreaterThanOrEqual(epoch + restores);
			expect(reports[0]).toBe(0);
			expect(Math.max(...pulls)).toBeLessThanOrEqual(sweepStep + sweepSkip);
			expect(live.seeded).toBe(true);
			expect(byOwner(live.store)).toEqual(byOwner(sweptFresh(wc)));
		}
	);

	it('reaches what a refused batch puts back at the end of the maps, unswept', () => {
		const model = new Model(metamodel);
		const ops: ModelOp[] = [];
		for (let i = 0; i < 300; i++) {
			ops.push({
				kind: 'create_element',
				temp_id: `tmp_o-${i}`,
				id: `o-${i}`,
				type_name: 'Other',
				properties: { name: `o${i}` }
			});
		}
		ops.splice(150, 0, {
			kind: 'create_element',
			temp_id: 'tmp_b-x',
			id: 'b-x',
			type_name: 'Blk',
			properties: { name: 'b', n: 9, req: 'x' }
		});
		// Without `lbl`, which a Link requires: an issue of its own.
		ops.push({
			kind: 'create_relationship',
			temp_id: 'tmp_l-x',
			id: 'l-x',
			type_name: 'Link',
			source_id: 'b-x',
			target_id: 'o-299'
		});
		applyBatch(model, ops);
		const wc = workingCopy(model);
		const fresh = byOwner(sweptFresh(wc));
		expect(fresh.map(([owner]) => owner)).toEqual(expect.arrayContaining(['b-x']));
		const live = new LiveIssues(wc, { sweepStep: 20 });
		const steps = live.sweepSteps();
		steps.next();
		steps.next();
		// b-x and its link go and come back, at the ends of the maps.
		expect(() =>
			live.stage([
				{ kind: 'delete_element', id: 'b-x' },
				{ kind: 'delete_element', id: 'gone' }
			])
		).toThrow(OpError);
		expect(wc.model.findRelationship('l-x')).toBeDefined();
		expect(drain(steps)).toBe(true);
		expect(byOwner(live.store)).toEqual(fresh);
	});

	it('ends while every few steps a probe makes the staged creates again, past what it has pulled', () => {
		const wc = workingCopy(grown(seededRandom(3), 1000));
		const sweepStep = 50;
		const live = new LiveIssues(wc, { sweepStep });
		live.stage(
			Array.from({ length: 600 }, (_, i): ModelOp => ({
				kind: 'create_element',
				temp_id: `tmp_new${i}`,
				type_name: 'Other',
				properties: { name: `n${i}` }
			}))
		);
		// What a list of every id taken at the start would take, in steps.
		const listed = Math.ceil((wc.model.elementCount + wc.model.relationshipCount) / sweepStep) + 2;
		const steps = live.sweepSteps();
		let taken = 0;
		for (let next = steps.next(); next.done !== true && taken < 3 * listed; next = steps.next()) {
			taken++;
			if (taken % 5 === 0) {
				live.stage([update('e-1', { name: `x${taken}` })]);
				live.origins();
			}
		}
		expect(taken).toBeLessThan(2 * listed);
		expect(live.seeded).toBe(true);
		expect(byOwner(live.store)).toEqual(byOwner(sweptFresh(wc)));
	});

	it('reports done === total at its last step only, entities made meanwhile included', () => {
		const random = seededRandom(9);
		const wc = workingCopy(grown(random, 400));
		const sweepStep = 50;
		const live = new LiveIssues(wc, { sweepStep });
		const during = pullCounter(wc.model);
		const steps = live.sweepSteps();
		const reports: { done: number; total: number }[] = [];
		for (let k = 0; ; k++) {
			const [next, pulled] = during(() => steps.next());
			if (k === 0) expect(pulled).toBeLessThanOrEqual(sweepStep);
			if (next.done === true) break;
			reports.push(next.value);
			for (let i = 0; i < 10; i++) {
				live.stage([
					{
						kind: 'create_element',
						temp_id: `tmp_${k}_${i}`,
						type_name: 'Other',
						properties: { name: `made ${k} ${i}` }
					}
				]);
			}
		}
		expect(reports[0]!.done).toBeLessThanOrEqual(sweepStep);
		const total = reports[0]!.total;
		expect(reports.every((report) => report.total === total)).toBe(true);
		expect(reports.slice(0, -1).every((report) => report.done < total)).toBe(true);
		expect(reports.at(-1)!.done).toBe(total);
		const dones = reports.map((report) => report.done);
		expect(dones).toEqual(dones.toSorted((a, b) => a - b));
		expect(byOwner(live.store)).toEqual(byOwner(sweptFresh(wc)));
	});
});

/** A replica of a small committed model, swept, with the server behind it. */
function small() {
	const model = new Model(metamodel);
	applyBatch(model, [
		{
			kind: 'create_element',
			temp_id: 'tmp_1',
			id: 'b-1',
			type_name: 'Blk',
			properties: { name: 'b1', n: 3, req: 'x' }
		},
		{
			kind: 'create_element',
			temp_id: 'tmp_2',
			id: 'b-2',
			type_name: 'Blk',
			properties: { name: 'b2', n: 9, req: 'y' }
		},
		{
			kind: 'create_element',
			temp_id: 'tmp_3',
			id: 'o-1',
			type_name: 'Other',
			properties: { name: 'o1' }
		}
	]);
	const server = new Server(model, 1);
	const wc = workingCopy(clone(model), server.rev);
	const live = new LiveIssues(wc);
	expect(drain(live.sweepSteps())).toBe(true);
	return { server, wc, live };
}

const update = (id: string, patch: { [key: string]: Value }): ModelOp => ({
	kind: 'update_element',
	id,
	properties_patch: patch
});

const listed = (live: LiveIssues) =>
	issueListBody(live).issues.map((i) => `${i.target_ids[0]}: ${i.message} (${i.origin})`);

describe('LiveIssues', () => {
	it('re-sweeps in place: the store stays whole throughout, and the waiters wait for the end', async () => {
		const random = seededRandom(11);
		const live = new LiveIssues(workingCopy(grown(random, 400)), { sweepStep: 50 });
		expect(live.seeded).toBe(false);
		drain(live.sweepSteps());
		expect(live.seeded).toBe(true);
		await live.whenSwept();
		const whole = byOwner(live.store);
		expect(whole.length).toBeGreaterThan(0);

		live.restartSweep();
		let swept = false;
		const waiting = live.whenSwept().then(() => (swept = true));
		const steps = live.sweepSteps();
		const reports: number[] = [];
		for (;;) {
			const next = steps.next();
			await Promise.resolve();
			if (next.done === true) break;
			reports.push(next.value.done);
			if (next.value.done < 600) expect(swept).toBe(false);
			expect(live.seeded).toBe(true);
			expect(byOwner(live.store)).toEqual(whole);
		}
		await waiting;
		expect(swept).toBe(true);
		expect(reports[0]).toBe(0);
		expect(reports.at(-1)).toBe(600);
	});

	it('moves its version on a change of issues and on an applied delta, not on a no-op edit', () => {
		const { server, wc, live } = small();
		const start = live.version;
		live.stage([update('o-1', { name: 'o1' })]);
		expect(live.version).toBe(start);
		live.stage([update('b-1', { n: 9 })]);
		expect(live.version).toBe(start + 1);
		// Nothing about issues moves, but the committed rev does.
		const { delta } = server.commit([update('o-1', { name: 'o1b' })]);
		const store = byOwner(live.store);
		expect(live.applyDelta(delta).status).toBe('applied');
		expect(byOwner(live.store)).toEqual(store);
		expect(live.version).toBe(start + 2);
		expect(wc.rev).toBe(2);
	});

	it('tags a staged issue on_server once its own commit lands, and lists it once', () => {
		const { server, live } = small();
		const create: ModelOp = {
			kind: 'create_element',
			temp_id: 'tmp_new',
			type_name: 'Blk',
			properties: { name: 'new', n: 8, req: 'r' }
		};
		const { batch } = live.stage([create]);
		expect(listed(live)).toEqual([
			'b-2: n: 9 above max 5.0 (on_server)',
			'tmp_new: n: 8 above max 5.0 (uncommitted)'
		]);
		const { delta, result } = server.commit([create]);
		const minted = result.idMap.get('tmp_new')!;
		expect(live.applyDelta(delta, { batchIds: [batch.id], idMap: result.idMap }).status).toBe(
			'applied'
		);
		expect(listed(live)).toEqual([
			'b-2: n: 9 above max 5.0 (on_server)',
			`${minted}: n: 8 above max 5.0 (on_server)`
		]);
		expect(issueListBody(live).counts).toEqual({ error: 2 });
	});

	it('lists no resolved issue, which validateModel appends', () => {
		const { live } = small();
		live.stage([update('b-2', { n: 2 }), update('b-1', { n: 7 })]);
		const body = issueListBody(live);
		expect(body.model_rev).toBe(1);
		expect(listed(live)).toEqual(['b-1: n: 7 above max 5.0 (uncommitted)']);
		expect(validateBody(live).map((i) => `${i.target_ids[0]} ${i.origin}`)).toEqual([
			'b-1 uncommitted',
			'b-2 resolved'
		]);
		expect(previewBody(live, true)).toMatchObject({
			conformance_error_count: 1,
			would_block: true
		});
		expect(previewBody(live, false).would_block).toBe(false);
	});

	it('finds the group a merged edit lands in when a later batch overwrites part of it', () => {
		// Keyless: every property is the identity. z matches none of x's states but the last.
		const model = new Model(metamodel);
		const blk = (id: string, properties: { [key: string]: Value }): ModelOp => ({
			kind: 'create_element',
			temp_id: `tmp_${id}`,
			id,
			type_name: 'Blk',
			properties
		});
		applyBatch(model, [
			blk('x', { name: 'k', n: 1, req: 'r' }),
			blk('z', { name: 'k', n: 2, req: 's' }),
			{ kind: 'create_element', temp_id: 'tmp_y', id: 'y', type_name: 'Other', properties: {} }
		]);
		const wc = workingCopy(model);
		const live = new LiveIssues(wc);
		drain(live.sweepSteps());
		expect(live.store.size).toBe(0);
		live.stage([update('x', { n: 3 })]);
		live.stage([update('x', { req: 's' }), update('y', { name: 'y2' })]);
		// Merged into the first batch, whose req the second overwrites: x ends as z is,
		// which no state of the trial run on top, key by key, ever matches.
		expect(live.stage([update('x', { req: 'q', n: 2 })], { coalesce: true }).coalesced).toBe(true);
		expect(wc.model.getElement('x').props).toEqual({ name: 'k', n: 2, req: 's' });
		expect(byOwner(live.store)).toEqual(byOwner(sweptFresh(wc)));
		expect(listed(live)).toEqual([
			'z: Duplicate Blk element z: matches x (no key — all properties match) (uncommitted)'
		]);
	});

	it('revalidates what a batch a merged edit parks had changed', () => {
		const model = new Model(metamodel);
		const other = (id: string): ModelOp => ({
			kind: 'create_element',
			temp_id: `tmp_${id}`,
			id,
			type_name: 'Other',
			properties: { name: id }
		});
		applyBatch(model, [other('w'), other('z'), other('x')]);
		const wc = workingCopy(model);
		const live = new LiveIssues(wc);
		drain(live.sweepSteps());
		live.stage([update('x', { name: 'x2' }), update('w', { name: 'z' })]);
		expect(listed(live)).toEqual([
			'z: Duplicate Other element z: matches w (no key — all properties match) (uncommitted)'
		]);
		// x again, as another type: the edit applies on top, but not merged into the first batch.
		live.stage([
			{ kind: 'delete_element', id: 'x' },
			{
				kind: 'create_element',
				temp_id: 'tmp_again',
				id: 'x',
				type_name: 'Blk',
				properties: { name: 'b', req: 'r' }
			}
		]);
		expect(live.stage([update('x', { n: 1 })], { coalesce: true }).coalesced).toBe(true);
		expect(wc.conflicts().map((conflict) => conflict.batch.id)).toEqual([1]);
		expect(wc.model.getElement('w').props).toEqual({ name: 'w' });
		expect(byOwner(live.store)).toEqual(byOwner(sweptFresh(wc)));
		expect(listed(live)).toEqual([]);
	});

	it('probes once per state: the origins are cached until the rev or the staged batches move', () => {
		const { live } = small();
		const none = live.origins();
		expect(none.dirty).toEqual([]);
		live.stage([update('b-1', { n: 7 })]);
		const first = live.origins();
		expect(first).not.toBe(none);
		expect(live.origins()).toBe(first);
		expect(first.dirty).toContain('b-1');
		expect(first.committed).toEqual([]);
		expect(first.working.map((i) => i.message)).toEqual(['n: 7 above max 5.0']);
		live.unstage('all');
		expect(live.origins()).not.toBe(first);
	});
});

const float = (value: number) => new PyFloat(value);

/** Rules over the `validation_steps` metamodel whose atoms reach two hops. */
const LINKED: RuleDoc = {
	name: 'linked',
	applies_to: 'Blk',
	when: { property: 'name', exists: true },
	then: {
		relationship: {
			type: 'Link',
			direction: 'outgoing',
			to: 'Other',
			exists: true,
			where: { relationship: { type: 'Owns', direction: 'incoming', exists: false } }
		}
	}
};
const OWNED: RuleDoc = {
	name: 'owned',
	applies_to: 'Other',
	then: {
		relationship: {
			type: 'Owns',
			direction: 'incoming',
			to: 'Blk',
			exists: true,
			where: { property: 'n', gte: float(3) }
		}
	}
};
const WHEELED: RuleDoc = {
	name: 'wheeled',
	applies_to: 'Car',
	then: {
		relationship: {
			type: 'Needs',
			direction: 'outgoing',
			to: 'Wheel',
			count: { gte: 1 },
			where: { relationship: { type: 'Owns', direction: 'incoming', exists: true } }
		}
	}
};

/** `ONE` for `Blk` and `Other`; `TWO` drops `Other`'s rule and adds one for `Car`; `THREE` keeps only that. */
const ONE = compileSets(metamodel, ['rs-1', 'Links', [LINKED, OWNED]]);
const TWO = compileSets(metamodel, ['rs-1', 'Links', [LINKED]], ['rs-2', 'Cars', [WHEELED]]);
const THREE = compileSets(metamodel, ['rs-2', 'Cars', [WHEELED]]);
const both = (rules: CompiledRules) => ({ working: rules, committed: rules });

/** Each owner's issues in order, owners sorted: what `IssueStore.replace` compares. */
const perOwner = (live: LiveIssues) =>
	[...live.store.owners()]
		.sort(cmpCodePoint)
		.map((owner) => [owner, live.store.issuesOf(owner).map(issueKey)]);

describe('rules in the store', () => {
	it.each([1, 2, 3])(
		'seed %i: rule sets changed mid-sweep, mid-rescan, over staged edits and after a delta end where a fresh sweep under the last ones ends',
		(seed) => {
			const random = seededRandom(seed);
			const server = new Server(grown(random, 1500), 1);
			const wc = workingCopy(clone(server.model), server.rev);
			const live = new LiveIssues(wc, { sweepStep: 61, rules: both(ONE) });
			const mine = new Churn(random, 'tmp_mine_');
			const peer = new Churn(random, 'tmp_peer_');
			const blks = [...wc.model.elements()].filter((e) => e.typeName === 'Blk').map((e) => e.id);
			const steps = live.sweepSteps();
			let script = 0;
			for (let k = 0; ; k++) {
				const next = steps.next();
				if (next.done === true) {
					expect(next.value).toBe(true);
					break;
				}
				shuffleAdjacency(wc.model, random);
				if (k === 2) {
					// a rule set staged while the sweep runs
					expect(live.seeded).toBe(false);
					live.setRules({ working: TWO, committed: ONE });
				} else if (k === 4) {
					// a rule's owner edited
					live.stage([
						update(
							blks.find((id) => wc.model.findElement(id))!,
							{ name: 'z' }
						)
					]);
				} else if (script === 0 && next.value === RESCAN_STEP) {
					// a second change before the rescan of the first ends, which
					// leaves the `Other`s it has not reached yet to that rescan
					expect(live.settled).toBe(false);
					live.setRules({ working: THREE, committed: ONE });
					script++;
				} else if (script === 1) {
					expect(live.settled).toBe(false);
					live.applyDelta(peerDelta(server, peer));
					script++;
				} else if (script === 2) {
					// the staged set committed, after the delta
					live.setRules(both(TWO));
					script++;
				} else {
					const roll = random();
					if (roll < 0.2) attempt(() => live.stage(mine.batch(wc.model)));
					else if (roll < 0.3 && wc.staged().length > 0) {
						live.unstage({ batch: wc.staged()[0]!.id });
					} else if (roll < 0.4) live.applyDelta(peerDelta(server, peer));
				}
			}
			expect(script).toBe(3);
			expect(live.seeded).toBe(true);
			expect(live.settled).toBe(true);
			expect(live.rules).toEqual(both(TWO));
			expect(byOwner(live.store)).toEqual(byOwner(sweptFresh(wc, TWO)));
		}
	);

	it('sweeps first, then rescans in steps that report no progress and leave seeded alone', () => {
		const live = new LiveIssues(workingCopy(grown(seededRandom(4), 300)), {
			sweepStep: 50,
			rules: both(ONE)
		});
		const steps = live.sweepSteps();
		const seen: string[] = [];
		for (;;) {
			const next = steps.next();
			if (next.done === true) break;
			const { done, total } = next.value;
			seen.push(next.value === RESCAN_STEP ? 'rescan' : done === total ? 'swept' : 'sweep');
			expect(live.seeded).toBe(seen.includes('swept'));
			if (seen.length === 2) live.setRules(both(TWO));
		}
		expect(seen.join(' ')).toMatch(/^(sweep )+swept( rescan)+$/);
		expect(byOwner(live.store)).toEqual(byOwner(sweptFresh(live.wc, TWO)));
	});

	it('moves its version on a rule-set change and on each rescan step that changes the store', () => {
		const live = new LiveIssues(workingCopy(grown(seededRandom(5), 300)), {
			sweepStep: 7,
			rules: both(ONE)
		});
		drain(live.sweepSteps());
		const { version, rulesVersion } = live;
		live.setRules(both(TWO));
		expect(live.version).toBe(version + 1);
		expect(live.rulesVersion).toBe(rulesVersion + 1);
		const moves: boolean[] = [];
		const steps = live.sweepSteps();
		for (;;) {
			const before = { store: JSON.stringify(perOwner(live)), version: live.version };
			const next = steps.next();
			if (next.done === true) break;
			const changed = JSON.stringify(perOwner(live)) !== before.store;
			expect(live.version).toBe(before.version + (changed ? 1 : 0));
			moves.push(changed);
		}
		expect(moves).toContain(true);
		expect(moves).toContain(false);
		expect(byOwner(live.store)).toEqual(byOwner(sweptFresh(live.wc, TWO)));
	});

	it('is not settled from a rule-set change until its rescan ends, and whenSettled resolves then', async () => {
		const live = new LiveIssues(workingCopy(grown(seededRandom(6), 200)), {
			sweepStep: 25,
			rules: both(ONE)
		});
		drain(live.sweepSteps());
		expect(live.settled).toBe(true);
		await live.whenSettled();
		live.setRules({ working: TWO, committed: ONE });
		expect(live.settled).toBe(false);
		let settled = false;
		let swept = false;
		const waiting = live.whenSettled().then(() => (settled = true));
		const sweeping = live.whenSwept().then(() => (swept = true));
		const steps = live.sweepSteps();
		for (;;) {
			const next = steps.next();
			await Promise.resolve();
			await Promise.resolve();
			if (next.done === true) break;
			expect(settled).toBe(live.settled);
			expect(swept).toBe(live.settled);
		}
		await Promise.all([waiting, sweeping]);
		expect(live.settled).toBe(true);
	});

	it('enqueues nothing when a set is only renamed, but moves its versions', () => {
		const live = new LiveIssues(workingCopy(grown(seededRandom(7), 200)), { rules: both(ONE) });
		drain(live.sweepSteps());
		const { version, rulesVersion } = live;
		const renamed = compileSets(metamodel, ['rs-1', 'Renamed', [LINKED, OWNED]]);
		live.setRules(both(renamed));
		expect(live.settled).toBe(true);
		expect(live.version).toBe(version + 1);
		expect(live.rulesVersion).toBe(rulesVersion + 1);
		expect([...live.sweepSteps()]).toEqual([]);
	});

	it('settles when the store becomes unusable mid-rescan', async () => {
		const mm = withPattern('('.repeat(64) + 'a' + ')'.repeat(64) + '*');
		const model = new Model(mm);
		for (let i = 0; i < 20; i++) {
			const element = model.createElement('Other', `o-${i}`);
			model.setProperty(element, 'name', `o${i}`);
		}
		const owned = compileSets(mm, ['rs-1', 'Owned', [OWNED]]);
		const live = new LiveIssues(workingCopy(model), { sweepStep: 5 });
		drain(live.sweepSteps());
		live.setRules(both(owned));
		const waiting = live.whenSettled();
		live.sweepSteps().next();
		expect(live.settled).toBe(false);
		live.stage([
			{
				kind: 'create_element',
				temp_id: 'tmp_b',
				type_name: 'Blk',
				properties: { name: 'b', req: 'r', code: 'a'.repeat(1_000_000) }
			}
		]);
		expect(live.unusable).toBe('pattern');
		await waiting;
		expect(live.settled).toBe(true);
	});
});

/**
 * Makes every element a validator run reaches throw while `armed.on`: a bug
 * in a validator, which no model can trigger.
 */
function breaking() {
	const armed = { on: true };
	const original = RulesValidator.prototype.validateElement;
	const spy = vi.spyOn(RulesValidator.prototype, 'validateElement').mockImplementation(function (
		this: RulesValidator,
		...args: Parameters<RulesValidator['validateElement']>
	) {
		if (armed.on) throw new Error('a validator bug');
		return original.apply(this, args);
	});
	return { armed, restore: () => spy.mockRestore() };
}

describe('a sweep or rescan step that throws', () => {
	it('leaves the ids the sweep had pulled to its next step, and releases what waits for it', async () => {
		const live = new LiveIssues(workingCopy(grown(seededRandom(12), 300)), { sweepStep: 40 });
		const steps = live.sweepSteps();
		steps.next();
		steps.next();
		let released = false;
		void live.whenSwept().then(() => (released = true));
		const broken = breaking();
		try {
			expect(() => steps.next()).toThrow('a validator bug');
		} finally {
			broken.restore();
		}
		await Promise.resolve();
		const after = { released, seeded: live.seeded };
		expect(drain(live.sweepSteps())).toBe(true);
		expect(live.seeded).toBe(true);
		expect(byOwner(live.store)).toEqual(byOwner(sweptFresh(live.wc)));
		expect(after).toEqual({ released: true, seeded: false });
	});

	it('leaves the ids a rescan step had taken queued, and releases what waits for it', async () => {
		// One step takes the whole queue.
		const live = new LiveIssues(workingCopy(grown(seededRandom(13), 300)), {
			sweepStep: 1000,
			rules: both(ONE)
		});
		drain(live.sweepSteps());
		live.setRules(both(TWO));
		let released = false;
		void live.whenSettled().then(() => (released = true));
		const broken = breaking();
		try {
			expect(() => live.sweepSteps().next()).toThrow('a validator bug');
		} finally {
			broken.restore();
		}
		await Promise.resolve();
		const after = { released, settled: live.settled };
		expect(drain(live.sweepSteps())).toBe(true);
		expect(live.settled).toBe(true);
		expect(byOwner(live.store)).toEqual(byOwner(sweptFresh(live.wc, TWO)));
		expect(after).toEqual({ released: true, settled: false });
	});
});

/**
 * A swept replica where `b-1` has relationships both ways and a referencer:
 * `b-2` names it in `ref`, it links to `o-1` and `b-3` owns it. `b-2` and
 * `b-3` each have an issue.
 */
function linked() {
	const blk = (id: string, properties: { [key: string]: Value }): ModelOp => ({
		kind: 'create_element',
		temp_id: `tmp_${id}`,
		id,
		type_name: 'Blk',
		properties: { name: id, req: 'x', ...properties }
	});
	const rel = (id: string, type_name: string, source_id: string, target_id: string): ModelOp => ({
		kind: 'create_relationship',
		temp_id: `tmp_${id}`,
		id,
		type_name,
		source_id,
		target_id,
		properties: type_name === 'Link' ? { lbl: 'l' } : {}
	});
	const model = new Model(metamodel);
	applyBatch(model, [
		blk('b-1', { n: 3 }),
		blk('b-2', { n: 9, ref: 'b-1' }),
		blk('b-3', { n: 9 }),
		{ kind: 'create_element', temp_id: 'tmp_o-1', id: 'o-1', type_name: 'Other', properties: {} },
		rel('l-1', 'Link', 'b-1', 'o-1'),
		rel('w-1', 'Owns', 'b-3', 'b-1')
	]);
	const server = new Server(model, 1);
	const wc = workingCopy(clone(model), server.rev);
	const live = new LiveIssues(wc);
	drain(live.sweepSteps());
	return { server, wc, live };
}

describe("the panel's tags", () => {
	it('after a merged keystroke on a staged element, come without a probe, its neighbourhood from the store', () => {
		const { wc, live } = linked();
		live.stage([update('b-1', { n: 7 })]);
		expect(listed(live)).toContain('b-1: n: 7 above max 5.0 (uncommitted)');
		const probes = vi.spyOn(wc, 'probeStaged');
		expect(live.stage([update('b-1', { n: 8 })], { coalesce: true }).coalesced).toBe(true);
		const body = issueListBody(live);
		expect(probes).not.toHaveBeenCalled();
		const scope = live.tagScope();
		for (const id of ['b-2', 'b-3', 'o-1', 'l-1', 'w-1']) {
			expect(scope.get(id), id).toEqual(live.store.issuesOf(id));
		}
		expect(scope.get('b-2')).toHaveLength(1);
		expect(listed(live)).toEqual([
			'b-1: n: 8 above max 5.0 (uncommitted)',
			'b-2: n: 9 above max 5.0 (on_server)',
			'b-3: n: 9 above max 5.0 (on_server)'
		]);
		// The same list as an exact probe tags it.
		live.resetTagScope();
		expect(issueListBody(live)).toEqual(body);
		expect(probes).toHaveBeenCalledTimes(1);
		expect(wc.model.getElement('b-1').props).toEqual({ name: 'b-1', req: 'x', n: 8 });
	});

	it('are kept only once the store is seeded: a read, an edit and a read mid-sweep tag as an exact probe', () => {
		const blk = (id: string, n: number): ModelOp => ({
			kind: 'create_element',
			temp_id: `tmp_${id}`,
			id,
			type_name: 'Blk',
			properties: { name: id, req: 'x', n }
		});
		const model = new Model(metamodel);
		applyBatch(model, [blk('b-1', 3), blk('b-2', 9)]);
		const live = new LiveIssues(workingCopy(model), { sweepStep: 1 });
		const steps = live.sweepSteps();
		steps.next();
		steps.next();
		// `b-2` is not swept yet: the store holds none of its issues.
		expect(live.store.issuesOf('b-2')).toEqual([]);
		issueListBody(live);
		live.stage([update('b-2', { name: 'b2' })]);
		drain(steps);
		expect(live.seeded).toBe(true);
		const body = issueListBody(live);
		live.resetTagScope();
		expect(body).toEqual(issueListBody(live));
		expect(listed(live)).toEqual(['b-2: n: 9 above max 5.0 (on_server)']);
	});

	it('probe again after a delta, a change of the committed rules, and while the rule sets differ', () => {
		const { server, wc, live } = linked();
		live.stage([update('b-1', { n: 7 })]);
		issueListBody(live);
		const probes = vi.spyOn(wc, 'probeStaged');
		const keystroke = (n: number) =>
			expect(live.stage([update('b-1', { n })], { coalesce: true }).coalesced).toBe(true);
		expect(live.applyDelta(server.commit([update('o-1', { name: 'o' })]).delta).status).toBe(
			'applied'
		);
		issueListBody(live);
		expect(probes).toHaveBeenCalledTimes(1);
		keystroke(8);
		issueListBody(live);
		expect(probes).toHaveBeenCalledTimes(1);

		live.setRules(both(ONE));
		drain(live.sweepSteps());
		issueListBody(live);
		expect(probes).toHaveBeenCalledTimes(2);
		keystroke(9);
		issueListBody(live);
		expect(probes).toHaveBeenCalledTimes(2);

		live.setRules({ working: TWO, committed: ONE });
		drain(live.sweepSteps());
		issueListBody(live);
		expect(probes).toHaveBeenCalledTimes(3);
		keystroke(10);
		issueListBody(live);
		expect(probes).toHaveBeenCalledTimes(4);
	});
});

/** The `validation_steps` metamodel with `Blk.code`'s pattern replaced. */
function withPattern(pattern: string): Metamodel {
	const copy = structuredClone(doc) as MetamodelDoc;
	const blk = copy.elements.find((type) => type.name === 'Blk')!;
	blk.properties.find((prop) => prop.name === 'code')!.pattern = pattern;
	return Metamodel.fromJSON(copy);
}

describe('a pattern the host cannot run', () => {
	// Nested groups under a star: past a million code units V8's backtracking stack runs out.
	const deep = '('.repeat(64) + 'a' + ')'.repeat(64) + '*';
	const long = 'a'.repeat(1_000_000);

	it('makes the patterns unusable for good once one throws mid-run', () => {
		const patterns = new FacetPatterns(withPattern(deep));
		expect(patterns.unusable).toBe(false);
		expect(patterns.fullmatch(deep, 'aaa')).toBe(true);
		expect(() => patterns.fullmatch(deep, long)).toThrow(PatternUnusable);
		expect(patterns.unusable).toBe(true);
		expect(() => patterns.fullmatch(deep, 'aaa')).toThrow(PatternUnusable);
	});

	it('sets unusable mid-stage, and the stage still answers', () => {
		const mm = withPattern(deep);
		const model = new Model(mm);
		applyBatch(model, [
			{
				kind: 'create_element',
				temp_id: 'tmp_1',
				id: 'b-1',
				type_name: 'Blk',
				properties: { name: 'b1', n: 9, req: 'x', code: 'aa' }
			}
		]);
		const live = new LiveIssues(workingCopy(model));
		drain(live.sweepSteps());
		expect(live.unusable).toBe(null);
		expect(live.store.size).toBe(1);
		const version = live.version;
		const answer = live.stage([update('b-1', { code: long })]);
		expect(answer.changes.elementIds).toEqual(['b-1']);
		expect(live.unusable).toBe('pattern');
		expect(live.store.size).toBe(0);
		expect(live.version).toBe(version + 1);
		// Sticky: a later stage of a short subject answers too, and nothing is validated.
		live.stage([update('b-1', { code: 'aa', n: 10 })]);
		expect(live.store.size).toBe(0);
		expect(() => issueListBody(live)).toThrow(PatternUnusable);
		expect(() => validateBody(live)).toThrow(PatternUnusable);
		expect(() => previewBody(live, false)).toThrow(PatternUnusable);
		expect(drain(live.sweepSteps())).toBe(false);
	});

	it('is unusable from the start when the translator refuses a pattern', () => {
		const live = new LiveIssues(workingCopy(new Model(withPattern('(?x)a'))));
		expect(live.unusable).toBe('pattern');
		expect(drain(live.sweepSteps())).toBe(false);
		expect(live.seeded).toBe(false);
	});
});
