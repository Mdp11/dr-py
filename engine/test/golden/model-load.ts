import {
	Metamodel,
	Model,
	parseLines,
	type MetamodelDoc,
	type ModelOptions
} from '../../src/index.ts';

/** Bulk-loads snapshot entity lines the way a snapshot reader does: parse, load in order, index. */
export function loadLines(
	metamodel: MetamodelDoc,
	elements: readonly string[],
	relationships: readonly string[],
	options: ModelOptions = {}
): Model {
	const model = new Model(Metamodel.fromJSON(metamodel), options);
	for (const doc of parseLines(elements)) model.loadElement(doc);
	for (const doc of parseLines(relationships)) model.loadRelationship(doc);
	model.rebuildIndexes();
	return model;
}
