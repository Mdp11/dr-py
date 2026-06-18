import type { ChangesDoc, Element, ModelOut, Relationship } from '$lib/api/types';
import { computeDiff, type EntityDiff } from './diff';

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
 * Build a Change Request describing the diff between `baseline` and `saved`.
 *
 * Both inputs must be canonical ModelOut values — i.e. all IDs are real,
 * not `tmp_*`. Callers are responsible for capturing the pre-save baseline
 * *before* it gets replaced; the post-save returned model is what makes all
 * IDs server-canonical.
 *
 * Pure: no I/O, no state. Inject `now` for deterministic timestamps in tests.
 */
export function buildChangeRequest(
	baseline: ModelOut,
	saved: ModelOut,
	baselineFilename: string | null,
	now: () => Date = () => new Date()
): ChangeRequest {
	// computeDiff's second parameter is typed Snapshot, but ModelOut is
	// structurally identical ({ elements, relationships }) and the diff
	// algorithm doesn't care which type label the working set carries.
	const diff = computeDiff(baseline, saved);

	const elementsAdded: Element[] = [];
	const elementsModified: ModifiedElement[] = [];
	const elementsDeleted: Element[] = [];
	partitionEntities<Element>(diff.elements, elementsAdded, elementsModified, elementsDeleted);

	const relsAdded: Relationship[] = [];
	const relsModified: ModifiedRelationship[] = [];
	const relsDeleted: Relationship[] = [];
	partitionEntities<Relationship>(diff.relationships, relsAdded, relsModified, relsDeleted);

	return {
		format: 'datarover.cr/v1',
		createdAt: now().toISOString(),
		baseline: {
			filename: baselineFilename,
			elementCount: baseline.elements.length,
			relationshipCount: baseline.relationships.length
		},
		ops: {
			elements: {
				added: elementsAdded,
				modified: elementsModified,
				deleted: elementsDeleted
			},
			relationships: {
				added: relsAdded,
				modified: relsModified,
				deleted: relsDeleted
			}
		}
	};
}

function partitionEntities<T>(
	diffs: EntityDiff[],
	added: T[],
	modified: { id: string; before: T; after: T }[],
	deleted: T[]
): void {
	for (const d of diffs) {
		if (d.status === 'added' && d.after) {
			added.push(d.after as T);
		} else if (d.status === 'modified' && d.before && d.after) {
			modified.push({
				id: d.id,
				before: d.before as T,
				after: d.after as T
			});
		} else if (d.status === 'deleted' && d.before) {
			deleted.push(d.before as T);
		}
	}
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
		// datarover.cr/v1 shape Apply CR and the compare flow expect
		const cr: Record<string, unknown> = { ...doc };
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
