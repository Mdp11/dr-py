import {
	applyBatch,
	elementLine,
	Model,
	modelLines,
	parseJson,
	relationshipLine,
	WorkingCopy,
	type BatchResult,
	type Delta,
	type ModelOp
} from '../../src/index.ts';
import { stateDigest } from '../golden/digest.ts';

/** A second model holding the same state, entity order and `rev`s included, loaded from its lines. */
export function clone(model: Model): Model {
	const copy = new Model(model.metamodel);
	const lines = modelLines(model);
	lines.slice(0, model.elementCount).forEach((line) => copy.loadElement(parseJson(line)));
	lines.slice(model.elementCount).forEach((line) => copy.loadRelationship(parseJson(line)));
	copy.rebuildIndexes();
	return copy;
}

/** Folds with the engine's own hash, while every digest it is held to comes from the reference one. */
export const workingCopy = (model: Model, rev = 0) =>
	new WorkingCopy(model, { rev, digest: stateDigest(model) });

/**
 * Stands in for the server: one model that lands batches under ids of its own
 * minting and says what a commit delta says.
 */
export class Server {
	readonly model: Model;
	rev: number;
	private minted = 0;

	constructor(model: Model, rev = 0) {
		this.model = model;
		this.rev = rev;
	}

	commit(ops: readonly ModelOp[]): { delta: Delta; result: BatchResult } {
		const result = applyBatch(this.model, ops, { idFor: () => `srv-${++this.minted}` });
		const model = this.model;
		const delta: Delta = {
			rev: this.rev + 1,
			prev_rev: this.rev,
			state_digest: stateDigest(model),
			changed_elements: [...result.changedElementIds].map((id) =>
				parseJson(elementLine(model.getElement(id)))
			),
			changed_relationships: [...result.changedRelationshipIds].map((id) =>
				parseJson(relationshipLine(model.getRelationship(id)))
			),
			deleted_element_ids: [...result.deletedElementIds],
			deleted_relationship_ids: [...result.deletedRelationshipIds],
			recreated_element_ids: [...result.recreatedElementIds],
			recreated_relationship_ids: [...result.recreatedRelationshipIds]
		};
		this.rev += 1;
		return { delta, result };
	}
}
