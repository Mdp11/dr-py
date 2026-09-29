/**
 * `POST /model/apply-cr` over the working copy: change requests applied in
 * turn to an overlay of it, the combined change request that results, its
 * gate and its ops.
 */
import type { Model } from '../model/model.ts';
import type { ElementRec, RelRec } from '../model/records.ts';
import { Meter } from '../navigation/evaluate.ts';
import { ReadError } from '../read/errors.ts';
import type { Wire } from '../read/wire.ts';
import type { Steps } from '../steps/steps.ts';
import { cmpCodePoint } from '../value/compare.ts';
import { pyEq } from '../value/eq.ts';
import { parseJson } from '../value/parse.ts';
import { pyRepr } from '../value/repr.ts';
import { PyFloat, type Value } from '../value/types.ts';
import type { WorkingCopy } from '../working/working-copy.ts';
import type { CrElement, CrKindOps, CrModified, CrRelationship, Diff } from './diff.ts';
import { CR_FORMAT, crDocument } from './document.ts';
import { opsForChange, type WireOp } from './ops.ts';
import { CrOverlay } from './overlay.ts';

/** The refusal of change requests the engine does not read: the client takes them to the server. */
export const UNREADABLE_CR = 'reaches an unreadable change request';

/** A change request's ops, as `readCrs` reads them. */
export type ChangeRequest = Diff;

export type CrConflict = {
	kind: 'id_exists' | 'missing' | 'before_mismatch';
	entity: 'element' | 'relationship';
	id: string;
	reason: string;
};

/** The 409 body: the first change request that conflicts with the state its predecessors left. */
export type ProposeConflict = { cr_index: number; conflicts: CrConflict[]; model_rev: number };

/** `ProposeCrResponse` in its key order, or the conflict the route answers with a 409. */
export type ProposeAnswer =
	{ model_rev: number; cr: { [key: string]: Wire }; ops: WireOp[] } | { conflict: ProposeConflict };

export type ProposeParams = { crs: readonly ChangeRequest[]; created_at: string };

type ElementOverlay = CrOverlay<ElementRec, CrElement>;
type RelOverlay = CrOverlay<RelRec, CrRelationship>;

/** The change requests applied: the working copy → result change request, and the result. */
export type Combined =
	| { diff: Diff; elements: ElementOverlay; relationships: RelOverlay }
	| { conflict: { cr_index: number; conflicts: CrConflict[] } };

/** `ProposeCrRequest`'s bound on the number of change requests. */
const MAX_CRS = 20;

/** Entities visited per step. */
const STEP_ENTITIES = 2048;

// -- reading -------------------------------------------------------------------

type Dict = { [key: string]: Value };

const unreadable = (): never => {
	throw new ReadError(501, UNREADABLE_CR);
};

const isDict = (value: Value | undefined): value is Dict =>
	typeof value === 'object' &&
	value !== null &&
	!Array.isArray(value) &&
	!(value instanceof PyFloat);

const field = (doc: Dict, key: string): Value | undefined =>
	Object.hasOwn(doc, key) ? doc[key] : undefined;

const isInt = (value: Value | undefined): boolean =>
	typeof value === 'number' || typeof value === 'bigint';

function dict(value: Value | undefined): Dict {
	return isDict(value) ? value : unreadable();
}

/** A dict field pydantic defaults when absent; `null` is refused. */
const optionalDict = (doc: Dict, key: string): Dict => {
	const value = field(doc, key);
	return value === undefined ? {} : dict(value);
};

function str(doc: Dict, key: string): string {
	const value = field(doc, key);
	return typeof value === 'string' ? value : unreadable();
}

function list(doc: Dict, key: string): Value[] {
	const value = field(doc, key);
	if (value === undefined) return [];
	return Array.isArray(value) ? value : unreadable();
}

function props(doc: Dict): Dict {
	const value = field(doc, 'properties');
	return value === undefined ? {} : dict(value);
}

function rev(doc: Dict): number | bigint {
	const value = field(doc, 'rev');
	if (value === undefined) return 0;
	return isInt(value) ? (value as number | bigint) : unreadable();
}

function readElement(value: Value): CrElement {
	const doc = dict(value);
	return {
		id: str(doc, 'id'),
		type_name: str(doc, 'type_name'),
		properties: props(doc),
		rev: rev(doc)
	};
}

function readRelationship(value: Value): CrRelationship {
	const doc = dict(value);
	return {
		id: str(doc, 'id'),
		type_name: str(doc, 'type_name'),
		source_id: str(doc, 'source_id'),
		target_id: str(doc, 'target_id'),
		properties: props(doc),
		rev: rev(doc)
	};
}

function readKind<E>(doc: Dict, entity: (value: Value) => E): CrKindOps<E> {
	return {
		added: list(doc, 'added').map(entity),
		modified: list(doc, 'modified').map((value): CrModified<E> => {
			const modified = dict(value);
			return {
				id: str(modified, 'id'),
				before: entity(field(modified, 'before') ?? unreadable()),
				after: entity(field(modified, 'after') ?? unreadable())
			};
		}),
		deleted: list(doc, 'deleted').map(entity)
	};
}

function readBaseline(value: Value): void {
	const doc = dict(value);
	const filename = field(doc, 'filename');
	if (filename !== undefined && filename !== null && typeof filename !== 'string') unreadable();
	for (const key of ['elementCount', 'relationshipCount']) {
		const count = field(doc, key);
		if (count !== undefined && !isInt(count)) unreadable();
	}
}

function readCr(value: Value): ChangeRequest {
	const doc = dict(value);
	if (field(doc, 'format') !== CR_FORMAT) unreadable();
	str(doc, 'createdAt');
	const baseline = field(doc, 'baseline');
	if (baseline !== undefined) readBaseline(baseline);
	const ops = optionalDict(doc, 'ops');
	return {
		elements: readKind(optionalDict(ops, 'elements'), readElement),
		relationships: readKind(optionalDict(ops, 'relationships'), readRelationship)
	};
}

/**
 * The request's change requests, read as the server reads the JSON a client
 * sends: through `JSON.stringify`, then as `readCrsText` reads it.
 */
export function readCrs(raw: unknown): ChangeRequest[] {
	let text: string | undefined;
	try {
		text = JSON.stringify(raw) as string | undefined;
	} catch {
		// A `bigint`, or a cycle.
		return unreadable();
	}
	return text === undefined ? unreadable() : readCrsText(text);
}

/**
 * The change requests of a request body's `crs`, as JSON text: parsed
 * exactly, then read strictly. What pydantic would refuse, or coerce (a
 * `rev` of `"3"` or `true`), is 501 `reaches an unreadable change request`;
 * extra keys are ignored.
 */
export function readCrsText(text: string): ChangeRequest[] {
	let docs: Value;
	try {
		docs = parseJson(text);
	} catch {
		return unreadable();
	}
	if (!Array.isArray(docs) || docs.length < 1 || docs.length > MAX_CRS) unreadable();
	return (docs as Value[]).map(readCr);
}

// -- applying ------------------------------------------------------------------

/** How a kind is matched, named and modified. */
type Kind<E> = {
	entity: 'element' | 'relationship';
	noun: string;
	/** `rev` is ignored. */
	matches(a: E, b: E): boolean;
	/** The entity a modify leaves under `id`. */
	modified(id: string, after: E, rev: number | bigint): E;
};

const ELEMENT: Kind<CrElement> = {
	entity: 'element',
	noun: 'Element',
	matches: (a, b) => a.type_name === b.type_name && pyEq(a.properties, b.properties),
	modified: (id, after, rev) => ({
		id,
		type_name: after.type_name,
		properties: after.properties,
		rev
	})
};

const RELATIONSHIP: Kind<CrRelationship> = {
	entity: 'relationship',
	noun: 'Relationship',
	matches: (a, b) =>
		a.type_name === b.type_name &&
		a.source_id === b.source_id &&
		a.target_id === b.target_id &&
		pyEq(a.properties, b.properties),
	modified: (id, after, rev) => ({
		id,
		type_name: after.type_name,
		source_id: after.source_id,
		target_id: after.target_id,
		properties: after.properties,
		rev
	})
};

/** Python's `rev + 1`: an integer past 2^53 is a `bigint`. */
const nextRev = (rev: number | bigint): number | bigint =>
	typeof rev === 'bigint' ? rev + 1n : rev < Number.MAX_SAFE_INTEGER ? rev + 1 : BigInt(rev) + 1n;

/** A working record, as an overlay finds it. */
type Rec = { readonly id: string; ord: number };

/** Phase A for one kind: every conflict with the state before the change request, in bucket order. */
function* conflictsOf<R extends Rec, E extends CrElement>(
	overlay: CrOverlay<R, E>,
	ops: CrKindOps<E>,
	kind: Kind<E>,
	conflicts: CrConflict[],
	meter: Meter
): Steps<void> {
	const { entity, noun } = kind;
	const conflict = (kindOf: CrConflict['kind'], id: string, reason: string) =>
		conflicts.push({ kind: kindOf, entity, id, reason: `${noun} ${pyRepr(id)} ${reason}` });
	for (const e of ops.added) {
		if (overlay.has(e.id)) conflict('id_exists', e.id, 'already exists in the model');
		if (meter.tick()) yield meter.end();
	}
	for (const { id, before } of ops.modified) {
		const current = overlay.get(id);
		if (current === undefined) conflict('missing', id, 'does not exist in the model');
		else if (!kind.matches(current, before)) {
			conflict('before_mismatch', id, 'does not match the before snapshot');
		}
		if (meter.tick()) yield meter.end();
	}
	for (const e of ops.deleted) {
		const current = overlay.get(e.id);
		if (current === undefined) conflict('missing', e.id, 'does not exist in the model');
		else if (!kind.matches(current, e)) {
			conflict('before_mismatch', e.id, 'does not match the deleted snapshot');
		}
		if (meter.tick()) yield meter.end();
	}
}

/** Phase B for one kind: a modify bumps the current `rev`; a delete of an id already gone is nothing. */
function* effectsOf<R extends Rec, E extends CrElement>(
	overlay: CrOverlay<R, E>,
	ops: CrKindOps<E>,
	kind: Kind<E>,
	meter: Meter
): Steps<void> {
	for (const e of ops.added) {
		overlay.set(e.id, e);
		if (meter.tick()) yield meter.end();
	}
	for (const { id, after } of ops.modified) {
		overlay.set(id, kind.modified(id, after, nextRev(overlay.get(id)!.rev)));
		if (meter.tick()) yield meter.end();
	}
	for (const e of ops.deleted) {
		overlay.delete(e.id);
		if (meter.tick()) yield meter.end();
	}
}

/** `diff_models(working, result)` for one kind, over the ids the change requests touched. */
function* diffOf<R extends Rec, E extends CrElement>(
	overlay: CrOverlay<R, E>,
	kind: Kind<E>,
	meter: Meter
): Steps<CrKindOps<E>> {
	const out: CrKindOps<E> = { added: [], modified: [], deleted: [] };
	for (const id of overlay.touched()) {
		const after = overlay.get(id)!;
		const before = overlay.base(id);
		if (before === undefined) out.added.push(after);
		else if (!kind.matches(before, after)) out.modified.push({ id, before, after });
		if (meter.tick()) yield meter.end();
	}
	for (const id of overlay.deleted()) {
		out.deleted.push(overlay.base(id)!);
		if (meter.tick()) yield meter.end();
	}
	return out;
}

const entries = (cr: ChangeRequest): number =>
	cr.elements.added.length +
	cr.elements.modified.length +
	cr.elements.deleted.length +
	cr.relationships.added.length +
	cr.relationships.modified.length +
	cr.relationships.deleted.length;

/**
 * The change requests applied in turn to an overlay of the working copy:
 * each checked against the state its predecessors left, the first with a
 * conflict ending the run, then the combined change request, which lists
 * what the change requests touched as `diff_models` would. A step every
 * 2,048 entities. It reads the working model across its yields, so the
 * model must not move between them; a scan guarantees that.
 */
export function* combinedDiffSteps(
	wc: WorkingCopy,
	crs: readonly ChangeRequest[]
): Steps<Combined> {
	const { model } = wc;
	// Each entry is visited twice, and touches at most one id the diff visits.
	const meter = new Meter(3 * crs.reduce((n, cr) => n + entries(cr), 0), STEP_ENTITIES);
	const elements = CrOverlay.elements(model);
	const relationships = CrOverlay.relationships(model);
	for (let index = 0; index < crs.length; index++) {
		const cr = crs[index]!;
		const conflicts: CrConflict[] = [];
		yield* conflictsOf(elements, cr.elements, ELEMENT, conflicts, meter);
		yield* conflictsOf(relationships, cr.relationships, RELATIONSHIP, conflicts, meter);
		if (conflicts.length > 0) return { conflict: { cr_index: index, conflicts } };
		yield* effectsOf(elements, cr.elements, ELEMENT, meter);
		yield* effectsOf(relationships, cr.relationships, RELATIONSHIP, meter);
	}
	const diff: Diff = {
		elements: yield* diffOf(elements, ELEMENT, meter),
		relationships: yield* diffOf(relationships, RELATIONSHIP, meter)
	};
	return { diff, elements, relationships };
}

// -- the gate --------------------------------------------------------------------

const refuse = (detail: string): never => {
	throw new ReadError(422, detail);
};

function requireEnd(elements: ElementOverlay, rid: string, role: string, elementId: string): void {
	if (!elements.has(elementId)) {
		refuse(`Relationship ${pyRepr(rid)} references unknown ${role} ${pyRepr(elementId)}`);
	}
}

/**
 * `_gate_cr_result`, its first refusal a 422: added then modified elements'
 * types, added then modified relationships' types and ends in the result,
 * then, per deleted element, its working relationships by code point that
 * survive, source then target.
 */
function gate(model: Model, diff: Diff, elements: ElementOverlay, relationships: RelOverlay): void {
	const { metamodel } = model;
	for (const e of [...diff.elements.added, ...diff.elements.modified.map((m) => m.after)]) {
		const type = metamodel.elementType(e.type_name);
		if (type === undefined) refuse(`Unknown element type ${pyRepr(e.type_name)}`);
		else if (type.abstract) {
			refuse(`Element type ${pyRepr(e.type_name)} is abstract and cannot be instantiated`);
		}
	}
	const checked: [string, CrRelationship][] = [
		...diff.relationships.added.map((r): [string, CrRelationship] => [r.id, r]),
		...diff.relationships.modified.map((m): [string, CrRelationship] => [m.id, m.after])
	];
	for (const [rid, r] of checked) {
		if (metamodel.relationshipType(r.type_name) === undefined) {
			refuse(`Unknown relationship type ${pyRepr(r.type_name)}`);
		}
		requireEnd(elements, rid, 'source', r.source_id);
		requireEnd(elements, rid, 'target', r.target_id);
	}
	for (const e of diff.elements.deleted) {
		const rec = model.findElement(e.id)!;
		const incident = new Set<string>();
		for (const r of rec.out) incident.add(r.id);
		for (const r of rec.in) incident.add(r.id);
		for (const rid of [...incident].sort(cmpCodePoint)) {
			const survivor = relationships.get(rid);
			if (survivor === undefined) continue;
			requireEnd(elements, rid, 'source', survivor.source_id);
			requireEnd(elements, rid, 'target', survivor.target_id);
		}
	}
}

/**
 * The proposal, in steps: the change requests applied and combined, then, in
 * the last step, the gate, the ops and the answer. `model_rev` is the
 * committed `rev`; the baseline the working counts; `createdAt` the param.
 */
export function* proposeSteps(wc: WorkingCopy, params: ProposeParams): Steps<ProposeAnswer> {
	const combined = yield* combinedDiffSteps(wc, params.crs);
	if ('conflict' in combined) return { conflict: { ...combined.conflict, model_rev: wc.rev } };
	const { diff, elements, relationships } = combined;
	gate(wc.model, diff, elements, relationships);
	const ops = opsForChange(diff);
	return {
		model_rev: wc.rev,
		cr: crDocument(
			diff,
			{ elementCount: wc.model.elementCount, relationshipCount: wc.model.relationshipCount },
			params.created_at
		),
		ops
	};
}
