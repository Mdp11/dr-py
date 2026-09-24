import { ReadError } from '../read/errors.ts';
import { parseJson } from '../value/parse.ts';
import { PyFloat, type Value } from '../value/types.ts';

/** A committed artifact as the shell hands it in: the server's artifact body. */
export type WireArtifact = {
	id: string;
	kind: string;
	name: string;
	artifact_rev: number;
	payload: { [key: string]: unknown };
};

/** One entry of the frontend's staged artifact buffer; a create's `id` is its temp id. */
export type WireStagedArtifact =
	| { op: 'create'; id: string; kind: string; name: string; payload: { [key: string]: unknown } }
	| { op: 'update'; id: string; name?: string; payload?: { [key: string]: unknown } }
	| { op: 'delete'; id: string };

type Doc = { [key: string]: Value };

export type CommittedArtifact = {
	id: string;
	kind: string;
	name: string;
	rev: number;
	payload: Doc;
};

export type StagedArtifact =
	| { op: 'create'; id: string; kind: string; name: string; payload: Doc }
	| { op: 'update'; id: string; name?: string; payload?: Doc }
	| { op: 'delete'; id: string };

/** An artifact as the working copy sees it. Its payload is read, never mutated. */
export type ResolvedArtifact = { id: string; kind: string; name: string; payload: Value };

// -- the boundary in -----------------------------------------------------------

const isDoc = (value: Value | undefined): value is Doc =>
	typeof value === 'object' &&
	value !== null &&
	!Array.isArray(value) &&
	!(value instanceof PyFloat);

function refuse(where: string, message: string): never {
	throw new ReadError(422, `${where}: ${message}`);
}

const field = (doc: Doc, key: string): Value | undefined =>
	Object.hasOwn(doc, key) ? doc[key] : undefined;

function str(doc: Doc, key: string, where: string): string {
	const value = field(doc, key);
	if (typeof value !== 'string') refuse(`${where}.${key}`, 'must be a string');
	return value;
}

function payload(doc: Doc, where: string): Doc {
	const value = field(doc, 'payload');
	if (!isDoc(value)) refuse(`${where}.payload`, 'must be an object');
	return value;
}

/**
 * A list as the client would send it, read as the server reads a body:
 * through `JSON.stringify` — an integral double becomes an `int` — and the
 * exact parser, so nothing of what was handed in is held.
 */
function readList(raw: unknown, where: string): Doc[] {
	if (!Array.isArray(raw)) refuse(where, 'must be a list');
	let docs: Value;
	try {
		docs = parseJson(JSON.stringify(raw));
	} catch (caught) {
		return refuse(where, `not JSON: ${(caught as Error).message}`);
	}
	return (docs as Value[]).map((doc, i) => {
		if (!isDoc(doc)) refuse(`${where}[${i}]`, 'must be an object');
		return doc;
	});
}

/** Committed artifacts, as `WireArtifact`s; a malformed one refuses the whole list. */
export function readArtifacts(raw: unknown, where = 'artifacts'): CommittedArtifact[] {
	return readList(raw, where).map((doc, i) => {
		const at = `${where}[${i}]`;
		const id = str(doc, 'id', at);
		const kind = str(doc, 'kind', at);
		const name = str(doc, 'name', at);
		const rev = field(doc, 'artifact_rev');
		if (typeof rev !== 'number') refuse(`${at}.artifact_rev`, 'must be an integer');
		return { id, kind, name, rev, payload: payload(doc, at) };
	});
}

/** Staged entries, as `WireStagedArtifact`s; a malformed one refuses the whole list. */
export function readStagedArtifacts(raw: unknown, where = 'entries'): StagedArtifact[] {
	return readList(raw, where).map((doc, i): StagedArtifact => {
		const at = `${where}[${i}]`;
		const op = field(doc, 'op');
		switch (op) {
			case 'create': {
				const id = str(doc, 'id', at);
				const kind = str(doc, 'kind', at);
				const name = str(doc, 'name', at);
				return { op, id, kind, name, payload: payload(doc, at) };
			}
			case 'update': {
				const id = str(doc, 'id', at);
				const name = field(doc, 'name') === undefined ? undefined : str(doc, 'name', at);
				const body = field(doc, 'payload') === undefined ? undefined : payload(doc, at);
				return {
					op,
					id,
					...(name === undefined ? {} : { name }),
					...(body === undefined ? {} : { payload: body })
				};
			}
			case 'delete':
				return { op, id: str(doc, 'id', at) };
		}
		return refuse(`${at}.op`, 'must be one of create, update, delete');
	});
}

// -- the set -------------------------------------------------------------------

/**
 * The project's artifacts: the committed ones the shell hands in, and over
 * them the staged overlay mirrored from the frontend's buffer, one entry per
 * id. It holds what the readers made and is not tied to a replica.
 */
export class ArtifactSet {
	private committed = new Map<string, CommittedArtifact>();
	private staged = new Map<string, StagedArtifact>();

	/** Replaces the committed layer. */
	setCommitted(list: readonly CommittedArtifact[]): void {
		this.committed = new Map(list.map((artifact) => [artifact.id, { ...artifact }]));
	}

	/** Upserts `changed` into the committed layer, then removes `deletedIds`. */
	put(changed: readonly CommittedArtifact[], deletedIds: readonly string[]): void {
		for (const artifact of changed) this.committed.set(artifact.id, { ...artifact });
		for (const id of deletedIds) this.committed.delete(id);
	}

	/** Replaces the staged overlay. */
	setStaged(entries: readonly StagedArtifact[]): void {
		this.staged = new Map(entries.map((entry) => [entry.id, { ...entry }]));
	}

	/**
	 * The artifact `id` names in the working copy: a staged delete hides it, a
	 * staged create is itself, a staged update lays its `name` / `payload`
	 * over the committed artifact — and names nothing when none is under it.
	 */
	resolve(id: string): ResolvedArtifact | null {
		const entry = this.staged.get(id);
		const committed = this.committed.get(id);
		if (entry === undefined) {
			if (committed === undefined) return null;
			return { id, kind: committed.kind, name: committed.name, payload: committed.payload };
		}
		switch (entry.op) {
			case 'delete':
				return null;
			case 'create':
				return { id, kind: entry.kind, name: entry.name, payload: entry.payload };
			case 'update':
				if (committed === undefined) return null;
				return {
					id,
					kind: committed.kind,
					name: entry.name ?? committed.name,
					payload: entry.payload ?? committed.payload
				};
		}
	}

	/** How many ids resolve. */
	get size(): number {
		let count = 0;
		for (const id of this.committed.keys()) {
			if (this.staged.get(id)?.op !== 'delete') count++;
		}
		for (const [id, entry] of this.staged) {
			if (entry.op === 'create' && !this.committed.has(id)) count++;
		}
		return count;
	}
}
