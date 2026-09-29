/**
 * `POST /model/compare` over the working copy: the uploaded file read, the
 * working copy diffed against it, the change request answered.
 */
import type { Wire } from '../read/wire.ts';
import type { Steps } from '../steps/steps.ts';
import type { Value } from '../value/types.ts';
import type { WorkingCopy } from '../working/working-copy.ts';
import { diffSteps } from './diff.ts';
import { crDocument } from './document.ts';
import { parseModelFile, readModelFile } from './read-file.ts';

/** `CompareResponse`, in its key order; `cr` is the working copy → file change request. */
export type CompareAnswer = {
	model_rev: number;
	cr: { [key: string]: Wire };
	other_element_count: number;
	other_relationship_count: number;
};

/**
 * An uploaded file, parsed at its first read and kept: the parse does not
 * depend on the model, so a compare that starts over does not repeat it.
 * A file that cannot be parsed is refused again at every read.
 */
export class UploadedFile {
	private readonly bytes: ArrayBuffer;
	private parsed: { value: Value } | null = null;

	constructor(bytes: ArrayBuffer) {
		this.bytes = bytes;
	}

	json(): Value {
		this.parsed ??= { value: parseModelFile(this.bytes) };
		return this.parsed.value;
	}
}

export type CompareParams = { file: ArrayBuffer | UploadedFile; created_at: string };

/**
 * The compare, in steps: the file read and checked in the first, then the
 * diff's. The model must not move between them; a scan guarantees that.
 */
export function* compareSteps(wc: WorkingCopy, params: CompareParams): Steps<CompareAnswer> {
	const file = params.file instanceof UploadedFile ? params.file : new UploadedFile(params.file);
	const other = readModelFile(file.json(), wc.model.metamodel);
	const diff = yield* diffSteps(wc, other);
	return {
		model_rev: wc.rev,
		cr: crDocument(
			diff,
			{ elementCount: wc.model.elementCount, relationshipCount: wc.model.relationshipCount },
			params.created_at
		),
		other_element_count: other.elements.size,
		other_relationship_count: other.relationships.size
	};
}
