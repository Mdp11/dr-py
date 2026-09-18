import type { Metamodel } from '../metamodel/metamodel.ts';
import { SnapshotError } from '../model/errors.ts';
import { Model, type ModelOptions } from '../model/model.ts';
import { parseJson, parseLines } from '../value/parse.ts';
import type { Value } from '../value/types.ts';
import { WorkingCopy, type WorkingCopyOptions } from '../working/working-copy.ts';
import { LineSplitter } from './lines.ts';
import { utf8Decoder } from './utf8.ts';

export const SNAPSHOT_V2_FORMAT = 'datarover.snapshot/v2';

// A writer puts `format` first, so these characters tell a v2 snapshot from anything else.
const V2_PREFIX = `{"format":"${SNAPSHOT_V2_FORMAT}"`;
const DIGEST = /^[0-9a-f]{16}$/;
// Lines parsed and loaded at a time: enough for one native parse to pay off,
// few enough to stay a short task between two chunks.
const BATCH_LINES = 2000;

/** The first line of a snapshot, in the wire's names. */
export type SnapshotHeader = {
	format: string;
	project_id: string;
	rev: number;
	metamodel_id: string;
	elements: number;
	relationships: number;
	state_digest: string;
};

export type OpenedSnapshot = { header: SnapshotHeader; workingCopy: WorkingCopy };

/** Told after every batch of entities: how many are loaded, of how many. */
export type OpenProgress = (done: number, total: number) => void;

export type OpenOptions = ModelOptions & WorkingCopyOptions;

function checkFormat(start: string): void {
	if (!start.startsWith(V2_PREFIX)) throw new SnapshotError(`not a ${SNAPSHOT_V2_FORMAT} snapshot`);
}

const isCount = (value: Value | undefined): value is number =>
	typeof value === 'number' && value >= 0;

function readHeader(line: string): SnapshotHeader {
	checkFormat(line);
	let doc: Value;
	try {
		doc = parseJson(line);
	} catch (caught) {
		throw new SnapshotError(`snapshot v2 header: ${(caught as Error).message}`);
	}
	const header = doc as { [key: string]: Value };
	const field = (key: string) => (Object.hasOwn(header, key) ? header[key] : undefined);
	const [elements, relationships] = [field('elements'), field('relationships')];
	if (!isCount(elements) || !isCount(relationships)) {
		throw new SnapshotError('snapshot v2 header carries no valid entity counts');
	}
	const [rev, digest] = [field('rev'), field('state_digest')];
	if (!isCount(rev)) throw new SnapshotError('snapshot v2 header carries no valid rev');
	if (typeof digest !== 'string' || !DIGEST.test(digest)) {
		throw new SnapshotError('snapshot v2 header carries no valid state digest');
	}
	const [projectId, metamodelId] = [field('project_id'), field('metamodel_id')];
	if (typeof projectId !== 'string' || typeof metamodelId !== 'string') {
		throw new SnapshotError('snapshot v2 header names no project and metamodel');
	}
	return {
		format: SNAPSHOT_V2_FORMAT,
		project_id: projectId,
		rev,
		metamodel_id: metamodelId,
		elements,
		relationships,
		state_digest: digest
	};
}

/** `parseLines`, with a line that does not parse named by its number in the snapshot. */
function parseBatch(lines: readonly string[], firstLine: number): Value[] {
	try {
		return parseLines(lines);
	} catch (batchError) {
		lines.forEach((line, i) => {
			try {
				parseJson(line);
			} catch (caught) {
				throw new SnapshotError(`snapshot v2 line ${firstLine + i}: ${(caught as Error).message}`);
			}
		});
		throw batchError;
	}
}

class Reader {
	header: SnapshotHeader | null = null;
	// Entity lines seen, loaded or not: a line past the promised ones is only counted.
	seen = 0;

	private readonly model: Model;
	private readonly onProgress: OpenProgress | undefined;
	private batch: string[] = [];

	constructor(model: Model, onProgress: OpenProgress | undefined) {
		this.model = model;
		this.onProgress = onProgress;
	}

	get total(): number {
		return this.header === null ? 0 : this.header.elements + this.header.relationships;
	}

	take(lines: readonly string[]): void {
		for (const line of lines) {
			if (this.header === null) this.header = readHeader(line);
			else {
				if (this.seen++ < this.total) this.batch.push(line);
				if (this.batch.length >= BATCH_LINES) this.load();
			}
		}
	}

	/** Parses and loads the lines held: the first `elements` of a snapshot are elements. */
	load(): void {
		if (this.batch.length === 0) return;
		const { model } = this;
		const elements = this.header!.elements;
		const first = model.elementCount + model.relationshipCount;
		// The header is line 1.
		parseBatch(this.batch, first + 2).forEach((doc, i) => {
			if (first + i < elements) model.loadElement(doc);
			else model.loadRelationship(doc);
		});
		this.batch = [];
		this.onProgress?.(model.elementCount + model.relationshipCount, this.total);
	}
}

/**
 * Reads a `datarover.snapshot/v2` text — the header line, then one line per
 * element, then one per relationship — from inflated bytes cut anywhere, into
 * an indexed replica at the header's `rev` and state digest. Lines are parsed
 * and loaded as they arrive, so the text is never held whole.
 *
 * The digest is adopted, not checked: `verifyDigest()` does that, whenever the
 * caller chooses. A text that cannot be read throws `SnapshotError`.
 */
export async function openSnapshot(
	chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
	metamodel: Metamodel,
	onProgress?: OpenProgress,
	options: OpenOptions = {}
): Promise<OpenedSnapshot> {
	const model = new Model(metamodel, options);
	const reader = new Reader(model, onProgress);
	const splitter = new LineSplitter();
	const decoder = utf8Decoder();
	const decode = (chunk?: Uint8Array) => {
		try {
			return decoder.decode(chunk, { stream: chunk !== undefined });
		} catch {
			throw new SnapshotError('snapshot is not valid UTF-8');
		}
	};

	for await (const chunk of chunks) {
		reader.take(splitter.push(decode(chunk)));
		// Anything but a v2 snapshot may be one endless line: refuse it at its first bytes.
		if (reader.header === null && splitter.pending.length >= V2_PREFIX.length) {
			checkFormat(splitter.pending);
		}
	}
	reader.take(splitter.push(decode()));
	// A last line may lack its LF; the server's own reader takes it too.
	if (splitter.pending !== '') reader.take([splitter.pending]);
	const header = reader.header;
	if (header === null) throw new SnapshotError(`not a ${SNAPSHOT_V2_FORMAT} snapshot`);
	// Checked before the last lines are parsed: what a cut text gets wrong first is its length.
	if (reader.seen !== reader.total) {
		throw new SnapshotError(
			`snapshot v2 holds ${reader.seen} entity lines, ` +
				`its header promises ${header.elements} + ${header.relationships}`
		);
	}
	reader.load();
	model.rebuildIndexes();
	const committed = { rev: header.rev, digest: header.state_digest };
	return { header, workingCopy: new WorkingCopy(model, committed, options) };
}
