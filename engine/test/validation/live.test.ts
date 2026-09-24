import { describe, expect, it } from 'vitest';
import {
	applyBatch,
	drain,
	FacetPatterns,
	issueListBody,
	LiveIssues,
	Metamodel,
	Model,
	OpError,
	PatternUnusable,
	previewBody,
	shuffleAdjacency,
	validateBody,
	type MetamodelDoc,
	type ModelOp,
	type Value
} from '../../src/index.ts';
import { loadFixture } from '../golden/load.ts';
import { seededRandom, type StepsFixture } from '../golden/model-steps.ts';
import { clone, Server, workingCopy } from '../working/helpers.ts';
import { byOwner, sweptFresh } from './helpers.ts';

const doc = loadFixture<StepsFixture>('validation_steps').metamodel;
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
