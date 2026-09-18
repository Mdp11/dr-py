import type { Model } from '../model/model.ts';
import type { BatchResult } from './result.ts';

/**
 * Puts back every entity a batch touched exactly as its before-image has it:
 * properties, `rev` and place in state order. The batch must be the newest
 * change still applied to the model.
 *
 * A record that outlived the batch still carries the `ord` of its image — a
 * record created again under the same id never does, creation always takes a
 * new one — and is rewritten where it is. Whatever else the batch left under a
 * touched id goes, relationships first; then what is missing comes back,
 * elements first.
 */
export function rewind(model: Model, result: BatchResult): void {
	for (const [id, image] of result.beforeRelationships) {
		const rel = model.findRelationship(id);
		if (rel === undefined) continue;
		if (image !== null && rel.ord === image.ord) {
			model.overwrite(rel, { ...image.props }, image.rev);
		} else {
			model.disconnect(id);
		}
	}
	for (const [id, image] of result.beforeElements) {
		const element = model.findElement(id);
		if (element === undefined) continue;
		if (image !== null && element.ord === image.ord) {
			model.overwrite(element, { ...image.props }, image.rev);
		} else {
			model.deleteElement(id);
		}
	}
	for (const [id, image] of result.beforeElements) {
		if (image !== null && model.findElement(id) === undefined) {
			model.insertElement(id, image.typeName, { ...image.props }, image.rev, image.ord);
		}
	}
	for (const [id, image] of result.beforeRelationships) {
		if (image !== null && model.findRelationship(id) === undefined) {
			model.insertRelationship(
				id,
				image.typeName,
				image.sourceId,
				image.targetId,
				{ ...image.props },
				image.rev,
				image.ord
			);
		}
	}
}
