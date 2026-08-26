import type { ChangesDoc, Conflict, Element, Relationship } from '$lib/api/types';
import {
	elementModifiedFields,
	relationshipModifiedFields,
	type Diff,
	type EntityDiff
} from './diff';

export interface ModifiedElement {
	id: string;
	before: Element;
	after: Element;
}

export interface ModifiedRelationship {
	id: string;
	before: Relationship;
	after: Relationship;
}

export interface ChangeRequest {
	format: 'datarover.cr/v1';
	createdAt: string;
	baseline: {
		filename: string | null;
		elementCount: number;
		relationshipCount: number;
	};
	ops: {
		elements: {
			added: Element[];
			modified: ModifiedElement[];
			deleted: Element[];
		};
		relationships: {
			added: Relationship[];
			modified: ModifiedRelationship[];
			deleted: Relationship[];
		};
	};
}

/**
 * Produce `<TS>_<base>.cr.json`.
 * - `<TS>` is local-time `YYYYMMDDTHHmmss`, zero-padded, no colons.
 * - `<base>` is `modelFilename` with the trailing extension stripped.
 * - Null or empty `modelFilename` falls back to `model`.
 */
export function composeCrFilename(
	modelFilename: string | null,
	now: () => Date = () => new Date()
): string {
	const base = stripExtension(modelFilename);
	const ts = localTimestamp(now());
	return `${ts}_${base}.cr.json`;
}

function stripExtension(filename: string | null): string {
	if (filename === null || filename.length === 0) return 'model';
	const dot = filename.lastIndexOf('.');
	if (dot <= 0) return filename; // no extension or leading dot
	return filename.slice(0, dot);
}

function localTimestamp(d: Date): string {
	const yyyy = d.getFullYear().toString().padStart(4, '0');
	const mm = (d.getMonth() + 1).toString().padStart(2, '0');
	const dd = d.getDate().toString().padStart(2, '0');
	const hh = d.getHours().toString().padStart(2, '0');
	const mi = d.getMinutes().toString().padStart(2, '0');
	const ss = d.getSeconds().toString().padStart(2, '0');
	return `${yyyy}${mm}${dd}T${hh}${mi}${ss}`;
}

export interface FileSaveOutcome {
	filename: string;
	handle: FileSystemFileHandle | null;
}

/** Writes a JSON value to a file (CR export seam — `saveJsonToFile`). */
export type SaveFileFn = (
	value: unknown,
	suggestedName: string,
	handle: FileSystemFileHandle | null
) => Promise<FileSaveOutcome>;

/** Streams an HTTP response to a file (model save seam — `saveResponseToFile`). */
export type SaveResponseFileFn = (
	response: Response,
	suggestedName: string,
	handle: FileSystemFileHandle | null
) => Promise<FileSaveOutcome>;

export interface SaveWithCrInput {
	/** Filename of the loaded model (suggested save name); null for "model.json". */
	filename: string | null;
	fileHandle: FileSystemFileHandle | null;
	exportCr: boolean;
	/** GET /model/download seam (returns the raw streaming Response). */
	download: () => Promise<Response>;
	/** GET /model/changes seam — only invoked when `exportCr` is true. */
	fetchChanges: () => Promise<ChangesDoc>;
	saveResponseFile: SaveResponseFileFn;
	saveFile: SaveFileFn;
	now?: () => Date;
}

export type SaveWithCrResult =
	| { kind: 'save-failed'; message: string }
	| {
			kind: 'saved';
			savedFilename: string;
			savedHandle: FileSystemFileHandle | null;
	  }
	| {
			kind: 'saved-cr-cancelled';
			savedFilename: string;
			savedHandle: FileSystemFileHandle | null;
	  }
	| {
			kind: 'saved-cr-failed';
			savedFilename: string;
			savedHandle: FileSystemFileHandle | null;
			message: string;
	  };

/**
 * Stream the SESSION model (GET /model/download) to a file and optionally
 * write the server-computed Change Request (GET /model/changes) beside it.
 *
 * This is an EXPORT convenience: it streams the SESSION model as it stands
 * server-side. Local staged edits are not part of the session until committed,
 * so the download reflects the last committed state, not the staged buffer.
 *
 * Pure orchestration: no state reads, no direct I/O — all four seams are
 * injected. Failure semantics (unchanged from the pre-delta flow):
 * - If the download or the model file write throws, no CR is attempted
 *   (`save-failed`; a user-cancelled save dialog also lands here).
 * - If the CR write throws an AbortError (user cancelled the save dialog),
 *   the result is `saved-cr-cancelled`; the model save still stands.
 * - Any other CR fetch/write error returns `saved-cr-failed` with the
 *   message; again the model save stands.
 */
export async function saveWithOptionalCr(input: SaveWithCrInput): Promise<SaveWithCrResult> {
	const suggestedName = input.filename ?? 'model.json';

	let modelOutcome: FileSaveOutcome;
	try {
		const response = await input.download();
		modelOutcome = await input.saveResponseFile(response, suggestedName, input.fileHandle);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { kind: 'save-failed', message };
	}

	if (!input.exportCr) {
		return {
			kind: 'saved',
			savedFilename: modelOutcome.filename,
			savedHandle: modelOutcome.handle
		};
	}

	const crName = composeCrFilename(input.filename, input.now);

	try {
		const doc = await input.fetchChanges();
		// strip the transport-only `complete` flag so the file is exactly the
		// datarover.cr/v1 shape Apply CR and the compare flow expect, and fill
		// in the baseline filename the server cannot know
		const cr: Record<string, unknown> = {
			...doc,
			baseline: { ...doc.baseline, filename: input.filename }
		};
		delete cr.complete;
		await input.saveFile(cr, crName, null);
	} catch (err) {
		if (err instanceof DOMException && err.name === 'AbortError') {
			return {
				kind: 'saved-cr-cancelled',
				savedFilename: modelOutcome.filename,
				savedHandle: modelOutcome.handle
			};
		}
		const message = err instanceof Error ? err.message : String(err);
		return {
			kind: 'saved-cr-failed',
			savedFilename: modelOutcome.filename,
			savedHandle: modelOutcome.handle,
			message
		};
	}

	return {
		kind: 'saved',
		savedFilename: modelOutcome.filename,
		savedHandle: modelOutcome.handle
	};
}

/** What the dialog's preview renders: the CR as a Diff plus the hidden count. */
export interface CrPreview {
	diff: Diff;
	unchangedHidden: number;
}

/** A 409 from POST /model/apply-cr: `crIndex` is null for a single-CR flow. */
export interface CrConflictReport {
	crIndex: number | null;
	items: Conflict[];
}

/**
 * The change request that undoes `cr` (added↔deleted, before↔after). Pure;
 * the envelope (format, createdAt, baseline, any extra field such as the
 * server's `complete`) is kept as-is — the caller relabels it.
 */
export function invertChangeRequest<T extends ChangeRequest>(cr: T): T {
	const { elements, relationships } = cr.ops;
	return {
		...cr,
		ops: {
			elements: {
				added: elements.deleted,
				modified: elements.modified.map((m) => ({ id: m.id, before: m.after, after: m.before })),
				deleted: elements.added
			},
			relationships: {
				added: relationships.deleted,
				modified: relationships.modified.map((m) => ({
					id: m.id,
					before: m.after,
					after: m.before
				})),
				deleted: relationships.added
			}
		}
	};
}

/** A CR as a renderable Diff: its six op buckets flattened back into
 * added/modified/deleted entries per entity kind. */
export function crToDiff(cr: Pick<ChangeRequest, 'ops'>): Diff {
	const { elements, relationships } = cr.ops;
	const els: EntityDiff[] = [
		...elements.added.map((e) => ({ id: e.id, status: 'added' as const, after: e })),
		...elements.modified.map((m) => ({
			id: m.id,
			status: 'modified' as const,
			before: m.before,
			after: m.after,
			modifiedFields: elementModifiedFields(m.before, m.after)
		})),
		...elements.deleted.map((e) => ({ id: e.id, status: 'deleted' as const, before: e }))
	];
	const rels: EntityDiff[] = [
		...relationships.added.map((r) => ({ id: r.id, status: 'added' as const, after: r })),
		...relationships.modified.map((m) => ({
			id: m.id,
			status: 'modified' as const,
			before: m.before,
			after: m.after,
			modifiedFields: relationshipModifiedFields(m.before, m.after)
		})),
		...relationships.deleted.map((r) => ({ id: r.id, status: 'deleted' as const, before: r }))
	];
	const counts = { added: 0, modified: 0, deleted: 0 };
	for (const d of [...els, ...rels]) {
		if (d.status !== 'unchanged') counts[d.status]++;
	}
	return { elements: els, relationships: rels, counts };
}

/** First entry per id — the output feeds a keyed list, so a `modified.before`
 * and a `deleted` sharing an id (impossible for a server CR, which partitions
 * by id, but a CR file is user-supplied) must not both survive. */
function byId<T extends { id: string }>(entities: T[]): T[] {
	const seen = new Set<string>();
	const out: T[] = [];
	for (const e of entities) {
		if (seen.has(e.id)) continue;
		seen.add(e.id);
		out.push(e);
	}
	return out;
}

/**
 * The pre-state a proposal already carries: the `before` of every modified
 * entity plus every deleted one — exactly the update/delete targets
 * `stageProposedOps` would otherwise fetch one by one.
 */
export function crPrestate(cr: ChangeRequest): {
	elements: Element[];
	relationships: Relationship[];
} {
	return {
		elements: byId([...cr.ops.elements.modified.map((m) => m.before), ...cr.ops.elements.deleted]),
		relationships: byId([
			...cr.ops.relationships.modified.map((m) => m.before),
			...cr.ops.relationships.deleted
		])
	};
}
