import { createHash } from 'node:crypto';
import { expect } from 'vitest';
import {
	cmpCodePoint,
	dumpIndexes,
	ElementRec,
	Metamodel,
	Model,
	ModelError,
	modelLines,
	pyDumps,
	RelRec,
	shuffleAdjacency,
	verifyConsistent,
	type MetamodelDoc,
	type ModelOptions
} from '../../src/index.ts';
import { stateDigest } from './digest.ts';
import { untag, type Tagged } from './load.ts';

/**
 * What `tests/golden/model_steps.py` records of the model after a step: always
 * the digest and a fingerprint of lines plus index dump; at a checkpoint the
 * lines and the dump too.
 */
export type Observed = { digest: string; fingerprint: string; state?: string[]; indexes?: string };

export type Step = Partial<Observed> & {
	do: string;
	id?: string;
	type?: string;
	prop?: string;
	source?: string;
	target?: string;
	value?: Tagged;
	detached?: 'element' | 'relationship';
	result: string | string[] | null;
	error: { kind: 'key' | 'value'; message: string } | null;
	unchanged?: true;
};

export type StepsFixture = { metamodel: MetamodelDoc; steps: Step[] };

/** A small seeded generator (mulberry32): test runs must be repeatable. */
export function seededRandom(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function fingerprint(state: readonly string[], indexes: string): string {
	const text = state.join('\n') + '\n' + indexes;
	return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/** The engine's side of `Observed`, the index dump as the oracle's compact JSON text. */
export function observe(model: Model): Required<Observed> {
	const state = modelLines(model);
	const indexes = pyDumps(dumpIndexes(model));
	return { digest: stateDigest(model), fingerprint: fingerprint(state, indexes), state, indexes };
}

const sortedIds = (rels: readonly RelRec[]) => rels.map((rel) => rel.id).sort(cmpCodePoint);

function entityOf(model: Model, step: Step): ElementRec | RelRec {
	if (step.detached === 'element') return new ElementRec(step.id!, step.type!, {}, 0, -1);
	if (step.detached === 'relationship') {
		const nowhere = new ElementRec('', '', {}, 0, -1);
		return new RelRec(step.id!, step.type!, nowhere, nowhere, {}, 0, -1);
	}
	return model.findElement(step.id!) ?? model.getRelationship(step.id!);
}

/** `mint` stands in for the oracle's `SequentialIdGenerator`, which a failed call never advances. */
function apply(model: Model, step: Step, mint: () => string): string | string[] | null {
	switch (step.do) {
		case 'create_element':
			return model.createElement(step.type!, mint()).id;
		case 'restore_element':
			return model.restoreElement(step.id!, step.type!).id;
		case 'get_element':
			return model.getElement(step.id!).id;
		case 'get_relationship':
			return model.getRelationship(step.id!).id;
		case 'set_property':
			model.setProperty(entityOf(model, step), step.prop!, untag(step.value!));
			return null;
		case 'delete_property':
			model.deleteProperty(entityOf(model, step), step.prop!);
			return null;
		case 'connect':
			return model.connect(step.type!, step.source!, step.target!, mint()).id;
		case 'restore_relationship':
			return model.restoreRelationship(step.id!, step.type!, step.source!, step.target!).id;
		case 'disconnect':
			model.disconnect(step.id!);
			return null;
		case 'delete_element':
			model.deleteElement(step.id!);
			return null;
		case 'container_of':
			return model.containerOf(step.id!);
		case 'relationships_from':
			return sortedIds(model.relationshipsFrom(step.id!));
		case 'relationships_to':
			return sortedIds(model.relationshipsTo(step.id!));
	}
	throw new Error(`unknown step ${step.do}`);
}

/**
 * Replays a recorded scenario through the engine, comparing every outcome and
 * the whole observable state after every step. Adjacency is shuffled before
 * each step and the indexes are checked against a rebuild after it.
 */
export function replaySteps(fixture: StepsFixture, options: ModelOptions = {}): void {
	const model = new Model(Metamodel.fromJSON(fixture.metamodel), options);
	const random = seededRandom(20260918);
	let minted = 0;
	let last = observe(model);
	fixture.steps.forEach((step, index) => {
		const label = `step ${index}: ${step.do}`;
		shuffleAdjacency(model, random);
		let result: string | string[] | null = null;
		let error: Step['error'] = null;
		try {
			result = apply(model, step, () => `id-${minted + 1}`);
			if (step.do === 'create_element' || step.do === 'connect') minted += 1;
		} catch (caught) {
			if (!(caught instanceof ModelError)) throw caught;
			error = { kind: caught.kind, message: caught.message };
		}
		expect(error, label).toEqual(step.error);
		expect(result, label).toEqual(step.result);
		const seen = observe(model);
		if (step.unchanged) {
			expect(seen, label).toEqual(last);
		} else {
			if (step.state !== undefined) {
				// A checkpoint: compare what can be read before what can only be seen.
				expect(seen.state, label).toEqual(step.state);
				expect(JSON.parse(seen.indexes), label).toEqual(JSON.parse(step.indexes!));
			}
			expect(seen.digest, label).toBe(step.digest);
			expect(seen.fingerprint, label).toBe(step.fingerprint);
		}
		verifyConsistent(model);
		expect(observe(model), `${label}, after a rebuild`).toEqual(seen);
		last = seen;
	});
}
