import { createHash } from 'node:crypto';
import { expect } from 'vitest';
import {
	applyBatch,
	cmpCodePoint,
	drain,
	dumpIndexes,
	elementLine,
	ElementRec,
	EVALUATIONS,
	isSteps,
	Metamodel,
	Model,
	ModelError,
	modelDigest,
	modelLines,
	OpError,
	parseJson,
	pyDumps,
	ReadError,
	READS,
	relationshipLine,
	RelRec,
	shuffleAdjacency,
	verifyConsistent,
	ViewPlacements,
	type BatchResult,
	type ElementImage,
	type MetamodelDoc,
	type ModelOp,
	type ModelOptions,
	type ReadParams,
	type RelImage,
	type Value
} from '../../src/index.ts';
import { untag, type Tagged } from './load.ts';

/**
 * What `tests/golden/model_steps.py` records of the model after a step: always
 * the digest and a fingerprint of lines plus index dump; at a checkpoint the
 * lines and the dump too.
 */
export type Observed = { digest: string; fingerprint: string; state?: string[]; indexes?: string };

/**
 * What a landed batch reports: ops, images and entities as lines of the
 * server's JSON text, and with them the delta a replica would be sent.
 */
export type BatchOutcome = {
	id_map: [string, string][];
	changed_element_ids: string[];
	changed_relationship_ids: string[];
	deleted_element_ids: string[];
	deleted_relationship_ids: string[];
	recreated_element_ids: string[];
	recreated_relationship_ids: string[];
	before_elements: [string, string | null][];
	before_relationships: [string, string | null][];
	inverse_ops: string[];
	changed_elements: string[];
	changed_relationships: string[];
};

export type StepError =
	{ kind: 'key' | 'value'; message: string } | { status: number; detail: string };

export type Step = Partial<Observed> & {
	do: string;
	id?: string;
	type?: string;
	prop?: string;
	source?: string;
	target?: string;
	value?: Tagged;
	detached?: 'element' | 'relationship';
	/** `batch`: the ops, one line of JSON text each; `restore` reinstates exact ids. */
	ops?: string[];
	restore?: boolean;
	/** `undo`: the index of the landed batch whose inverse ops to run. */
	of?: number;
	/** `read`: a method of `READS` or of `EVALUATIONS`, and its params. */
	method?: string;
	params?: ReadParams;
	/** `view` / `drop_view`: the view whose placements `result` lists / to forget. */
	view_id?: string;
	result: string | string[] | BatchOutcome | object | null;
	error: StepError | null;
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
	return { digest: modelDigest(model), fingerprint: fingerprint(state, indexes), state, indexes };
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

export const parseOps = (lines: readonly string[]) =>
	lines.map((line) => parseJson(line) as unknown as ModelOp);

const elementImageLine = (image: ElementImage) =>
	pyDumps({ id: image.id, type_name: image.typeName, properties: image.props, rev: image.rev });

const relImageLine = (image: RelImage) =>
	pyDumps({
		id: image.id,
		type_name: image.typeName,
		source_id: image.sourceId,
		target_id: image.targetId,
		properties: image.props,
		rev: image.rev
	});

/** The engine's side of `BatchOutcome`, every line rendered by the engine's own serializer. */
export function outcome(model: Model, res: BatchResult): BatchOutcome {
	return {
		id_map: [...res.idMap],
		changed_element_ids: [...res.changedElementIds],
		changed_relationship_ids: [...res.changedRelationshipIds],
		deleted_element_ids: [...res.deletedElementIds],
		deleted_relationship_ids: [...res.deletedRelationshipIds],
		recreated_element_ids: [...res.recreatedElementIds],
		recreated_relationship_ids: [...res.recreatedRelationshipIds],
		before_elements: [...res.beforeElements].map(([id, image]) => [
			id,
			image === null ? null : elementImageLine(image)
		]),
		before_relationships: [...res.beforeRelationships].map(([id, image]) => [
			id,
			image === null ? null : relImageLine(image)
		]),
		inverse_ops: res.inverseOps().map((op) => pyDumps(op as unknown as Value)),
		changed_elements: [...res.changedElementIds].map((id) => elementLine(model.getElement(id))),
		changed_relationships: [...res.changedRelationshipIds].map((id) =>
			relationshipLine(model.getRelationship(id))
		)
	};
}

/** What a replay carries from step to step: the batches that landed, by step index, and the views. */
type Landed = Map<number, BatchResult>;
type Carried = { landed: Landed; placements: ViewPlacements };

/**
 * `mint` stands in for the oracle's `SequentialIdGenerator`. A failed call
 * consumes no id, and neither does a refused batch: the oracle runs each on a
 * copy of its model and drops the copy, generator included.
 */
function apply(
	model: Model,
	step: Step,
	index: number,
	mint: () => string,
	{ landed, placements }: Carried
): unknown {
	switch (step.do) {
		case 'read': {
			const method = step.method!;
			const params = step.params ?? {};
			if (Object.hasOwn(READS, method)) {
				const out = READS[method]!(model, placements, params);
				return isSteps(out) ? drain(out) : out;
			}
			if (Object.hasOwn(EVALUATIONS, method)) {
				return drain(EVALUATIONS[method]!({ model, artifacts: null, placements }, params));
			}
			throw new Error(`no read ${method}`);
		}
		case 'view':
			placements.set(step.view_id!, step.result as string[]);
			return step.result;
		case 'drop_view':
			placements.drop(step.view_id!);
			return null;
		case 'batch':
		case 'undo': {
			const ops = step.do === 'batch' ? parseOps(step.ops!) : landed.get(step.of!)!.inverseOps();
			const restore = step.do === 'undo' || step.restore === true;
			const res = applyBatch(model, ops, { restore, idFor: mint });
			landed.set(index, res);
			return outcome(model, res);
		}
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
	const carried: Carried = { landed: new Map(), placements: new ViewPlacements() };
	let minted = 0;
	let last = observe(model);
	fixture.steps.forEach((step, index) => {
		const label = `step ${index}: ${step.do}`;
		shuffleAdjacency(model, random);
		let result: unknown = null;
		let error: Step['error'] = null;
		const mintedBefore = minted;
		try {
			result = apply(model, step, index, () => `id-${++minted}`, carried);
		} catch (caught) {
			minted = mintedBefore;
			if (caught instanceof ModelError) error = { kind: caught.kind, message: caught.message };
			else if (caught instanceof OpError) error = { status: caught.status, detail: caught.detail };
			else if (caught instanceof ReadError) {
				error = { status: caught.status, detail: caught.detail };
			} else throw caught;
		}
		expect(error, label).toEqual(step.error);
		// A body is compared as text: values and key order at once.
		if (step.do === 'read') expect(JSON.stringify(result), label).toBe(JSON.stringify(step.result));
		else expect(result, label).toEqual(step.result);
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
