import { ReadError } from '../read/errors.ts';
import type { RulesParse } from '../rules/compile.ts';
import { parseJson } from '../value/parse.ts';
import { PyFloat, type Value } from '../value/types.ts';

/**
 * A committed artifact as the shell hands it in: the server's artifact body.
 * A rule set carries the server's parse of its YAML in `rules`.
 */
export type WireArtifact = {
	id: string;
	kind: string;
	name: string;
	artifact_rev: number;
	payload: { [key: string]: unknown };
	rules?: RulesParse | null;
};

/**
 * One entry of the frontend's staged artifact buffer; a create's `id` is its
 * temp id. A rule set's create, or update with a payload, carries the parse
 * of its YAML in `rules`, `'pending'` while the parse is out.
 */
export type WireStagedArtifact =
	| {
			op: 'create';
			id: string;
			kind: string;
			name: string;
			payload: { [key: string]: unknown };
			rules?: RulesParse | 'pending';
	  }
	| {
			op: 'update';
			id: string;
			name?: string;
			payload?: { [key: string]: unknown };
			rules?: RulesParse | 'pending';
	  }
	| { op: 'delete'; id: string };

type Doc = { [key: string]: Value };

export type CommittedArtifact = {
	id: string;
	kind: string;
	name: string;
	rev: number;
	payload: Doc;
	rules?: RulesParse;
};

export type StagedArtifact =
	| {
			op: 'create';
			id: string;
			kind: string;
			name: string;
			payload: Doc;
			rules?: RulesParse | 'pending';
	  }
	| { op: 'update'; id: string; name?: string; payload?: Doc; rules?: RulesParse | 'pending' }
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
 * `POST /rules/parse`'s body: `ok` with the document text, or the parse
 * errors, of which the first is the reason. Other keys are ignored.
 */
function rulesParse(value: Value, where: string): RulesParse {
	if (!isDoc(value)) refuse(where, 'must be an object');
	const ok = field(value, 'ok');
	if (ok === true) {
		const document = field(value, 'document');
		if (typeof document !== 'string') refuse(`${where}.document`, 'must be a string');
		return { ok, document };
	}
	if (ok !== false) refuse(`${where}.ok`, 'must be a boolean');
	const errors = field(value, 'errors');
	if (!Array.isArray(errors) || errors.length === 0) {
		refuse(`${where}.errors`, 'must be a non-empty list');
	}
	return {
		ok,
		errors: errors.map((error, i) => {
			const at = `${where}.errors[${i}]`;
			if (!isDoc(error)) refuse(at, 'must be an object');
			return { message: str(error, 'message', at) };
		})
	};
}

/** A committed artifact's `rules`: absent and `null` alike carry no parse. */
function committedRules(doc: Doc, where: string): { rules?: RulesParse } {
	const value = field(doc, 'rules');
	return value === undefined || value === null
		? {}
		: { rules: rulesParse(value, `${where}.rules`) };
}

/** A staged entry's `rules`: a parse, or `'pending'`. */
function stagedRules(doc: Doc, where: string): { rules?: RulesParse | 'pending' } {
	const value = field(doc, 'rules');
	if (value === undefined) return {};
	if (value === 'pending') return { rules: value };
	if (!isDoc(value)) refuse(`${where}.rules`, "must be an object or 'pending'");
	return { rules: rulesParse(value, `${where}.rules`) };
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
		return { id, kind, name, rev, payload: payload(doc, at), ...committedRules(doc, at) };
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
				return { op, id, kind, name, payload: payload(doc, at), ...stagedRules(doc, at) };
			}
			case 'update': {
				const id = str(doc, 'id', at);
				const name = field(doc, 'name') === undefined ? undefined : str(doc, 'name', at);
				const body = field(doc, 'payload') === undefined ? undefined : payload(doc, at);
				return {
					op,
					id,
					...(name === undefined ? {} : { name }),
					...(body === undefined ? {} : { payload: body }),
					...stagedRules(doc, at)
				};
			}
			case 'delete':
				return { op, id: str(doc, 'id', at) };
		}
		return refuse(`${at}.op`, 'must be one of create, update, delete');
	});
}

// -- the set -------------------------------------------------------------------

/** Whether two entries hold the same fields, in the same order, with exactly the same values. */
function alike(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a instanceof PyFloat || b instanceof PyFloat) {
		return a instanceof PyFloat && b instanceof PyFloat && Object.is(a.value, b.value);
	}
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const [x, y] = [a as { [key: string]: unknown }, b as { [key: string]: unknown }];
	const keys = Object.keys(x);
	const other = Object.keys(y);
	return (
		keys.length === other.length &&
		keys.every((key, i) => key === other[i] && alike(x[key], y[key]))
	);
}

/** Whether two layers hold alike entries under the same ids, in the same order. */
function sameLayer<T>(a: ReadonlyMap<string, T>, b: ReadonlyMap<string, T>): boolean {
	if (a.size !== b.size) return false;
	const others = b.entries();
	for (const [id, entry] of a) {
		const [otherId, other] = others.next().value as [string, T];
		if (id !== otherId || !alike(entry, other)) return false;
	}
	return true;
}

/** A create, or an update carrying a payload: an entry that stands for the artifact's content. */
export const carriesPayload = (
	entry: StagedArtifact | undefined
): entry is Exclude<StagedArtifact, { op: 'delete' }> =>
	entry?.op === 'create' || (entry?.op === 'update' && entry.payload !== undefined);

/**
 * The project's artifacts: the committed ones the shell hands in, and over
 * them the staged overlay mirrored from the frontend's buffer, one entry per
 * id. It holds what the readers made and is not tied to a replica.
 */
export class ArtifactSet {
	private committed = new Map<string, CommittedArtifact>();
	private staged = new Map<string, StagedArtifact>();
	/**
	 * Per rule set, the parse a `'pending'` entry stands on: the last one a
	 * staged payload brought, or the committed one while none stands over it.
	 */
	private lastParse = new Map<string, RulesParse>();
	private moves = 0;

	/**
	 * Moves whenever a layer comes to hold other entries: one added, removed
	 * or replaced by one that is not alike. Handed the same entries again, it
	 * stays.
	 */
	get version(): number {
		return this.moves;
	}

	/** Replaces the committed layer. */
	setCommitted(list: readonly CommittedArtifact[]): void {
		const before = this.committed;
		this.committed = new Map(list.map((artifact) => [artifact.id, { ...artifact }]));
		for (const artifact of list) this.keepCommittedParse(artifact);
		this.forgetGone();
		if (!sameLayer(before, this.committed)) this.moves++;
	}

	/** Upserts `changed` into the committed layer, then removes `deletedIds`. */
	put(changed: readonly CommittedArtifact[], deletedIds: readonly string[]): void {
		let moved = false;
		for (const artifact of changed) {
			moved ||= !alike(this.committed.get(artifact.id), artifact);
			this.committed.set(artifact.id, { ...artifact });
			this.keepCommittedParse(artifact);
		}
		for (const id of deletedIds) moved = this.committed.delete(id) || moved;
		this.forgetGone();
		if (moved) this.moves++;
	}

	/**
	 * Replaces the staged overlay. An entry that no longer carries a payload —
	 * discarded, or left with a rename alone — takes its staged parse with it:
	 * the committed one is the last parse again.
	 */
	setStaged(entries: readonly StagedArtifact[]): void {
		const before = this.staged;
		this.staged = new Map(entries.map((entry) => [entry.id, { ...entry }]));
		for (const entry of entries) {
			if (carriesPayload(entry) && entry.rules !== 'pending') this.keepParse(entry.id, entry.rules);
		}
		for (const [id, entry] of before) {
			if (!carriesPayload(entry) || carriesPayload(this.staged.get(id))) continue;
			const committed = this.committed.get(id)?.rules;
			if (committed === undefined) this.lastParse.delete(id);
			else this.lastParse.set(id, committed);
		}
		this.forgetGone();
		if (!sameLayer(before, this.staged)) this.moves++;
	}

	private keepParse(id: string, parse: RulesParse | undefined): void {
		if (parse !== undefined) this.lastParse.set(id, parse);
	}

	/**
	 * Keeps a committed parse unless a staged payload stands over the id: a
	 * `'pending'` there keeps standing on the payload's.
	 */
	private keepCommittedParse(artifact: CommittedArtifact): void {
		if (!carriesPayload(this.staged.get(artifact.id))) this.keepParse(artifact.id, artifact.rules);
	}

	private forgetGone(): void {
		for (const id of this.lastParse.keys()) {
			if (!this.committed.has(id) && !this.staged.has(id)) this.lastParse.delete(id);
		}
	}

	/** Every id either layer holds: the committed ones, then the ones staged alone. */
	ids(): string[] {
		const out = [...this.committed.keys()];
		for (const id of this.staged.keys()) if (!this.committed.has(id)) out.push(id);
		return out;
	}

	/** The committed artifact under `id`. Read, never mutated. */
	committedArtifact(id: string): CommittedArtifact | undefined {
		return this.committed.get(id);
	}

	/** The staged entry for `id`. Read, never mutated. */
	stagedEntry(id: string): StagedArtifact | undefined {
		return this.staged.get(id);
	}

	/**
	 * The parse a `'pending'` entry for the rule set `id` stands on until its
	 * own lands: the last one a staged payload brought, or the committed one.
	 */
	lastWorkingParse(id: string): RulesParse | undefined {
		return this.lastParse.get(id);
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
