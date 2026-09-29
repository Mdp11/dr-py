/**
 * `GET /model/download` in steps: the committed model as `iter_model_json`
 * writes it, whatever is staged, answered as UTF-8 parts. Nothing is
 * published before the last step.
 */
import { PART_BYTES } from '../export/route.ts';
import { Meter } from '../navigation/evaluate.ts';
import type { ElementImage, RelImage } from '../ops/result.ts';
import { ReadError } from '../read/errors.ts';
import type { Progress, Steps } from '../steps/steps.ts';
import { pyDumps } from '../value/serialize.ts';
import type { Value } from '../value/types.ts';
import type { WorkingCopy } from '../working/working-copy.ts';
import { PartWriter } from './parts.ts';

/** The file as the route ships it: its bytes, and the name and type its headers carry. */
export type ModelFile = {
	parts: ArrayBuffer[];
	filename: 'model.json';
	content_type: 'application/json';
};

const NON_FINITE = 'Out of range float values are not JSON compliant';

// Entities sit two levels deep, so their own indented text moves right by two steps.
const ENTITY_BREAK = '\n    ';

const elementEntity = (image: ElementImage): { [key: string]: Value } => ({
	id: image.id,
	type_name: image.typeName,
	properties: image.props,
	rev: image.rev
});

const relEntity = (image: RelImage): { [key: string]: Value } => ({
	id: image.id,
	type_name: image.typeName,
	source_id: image.sourceId,
	target_id: image.targetId,
	properties: image.props,
	rev: image.rev
});

/** One entity's text as it stands in the file; a non-finite float is a 422. */
function entityText(entity: { [key: string]: Value }): string {
	let text: string;
	try {
		text = pyDumps(entity, 2);
	} catch (caught) {
		if (caught instanceof RangeError && caught.message === NON_FINITE) {
			throw new ReadError(422, NON_FINITE);
		}
		throw caught;
	}
	return text.replaceAll('\n', ENTITY_BREAK);
}

/**
 * How many entities committed state holds: the model's, less the ones staged
 * batches left in it, plus the committed ones they stand over.
 */
function committedCount(wc: WorkingCopy): number {
	const { elements, relationships } = wc.stagedDiff();
	let count = wc.model.elementCount + wc.model.relationshipCount;
	for (const { before, after } of [...elements, ...relationships]) {
		if (before !== null) count++;
		if (after !== null) count--;
	}
	return count;
}

/** `"<key>": [...]`, one level in, with no trailing comma; a step ends every 1,024 entities. */
function* entityList<I>(
	writer: PartWriter,
	meter: Meter,
	key: string,
	images: Iterable<I>,
	entity: (image: I) => { [key: string]: Value }
): Generator<Progress, void, void> {
	let first = true;
	for (const image of images) {
		writer.write(first ? `  "${key}": [${ENTITY_BREAK}` : `,${ENTITY_BREAK}`);
		writer.write(entityText(entity(image)));
		first = false;
		if (meter.tick()) yield meter.end();
	}
	writer.write(first ? `  "${key}": []` : '\n  ]');
}

/**
 * The committed model's file, in steps of 1,024 entities. It reads the
 * working copy's committed iteration, so the model must not move between
 * its steps; a scan guarantees that.
 */
export function* modelFileSteps(wc: WorkingCopy, partBytes = PART_BYTES): Steps<ModelFile> {
	const meter = new Meter(committedCount(wc));
	const writer = new PartWriter(partBytes);
	writer.write('{\n');
	yield* entityList(writer, meter, 'elements', wc.committedElementsInOrder(), elementEntity);
	writer.write(',\n');
	yield* entityList(writer, meter, 'relationships', wc.committedRelationshipsInOrder(), relEntity);
	writer.write('\n}');
	return { parts: writer.finish(), filename: 'model.json', content_type: 'application/json' };
}
