/**
 * `diff_models(working, other)` in steps: the change request that turns the
 * working copy into an uploaded file's model.
 */
import type { ElementRec, RelRec } from '../model/records.ts';
import { Meter } from '../navigation/evaluate.ts';
import type { Steps } from '../steps/steps.ts';
import { pyEq } from '../value/eq.ts';
import type { Value } from '../value/types.ts';
import type { WorkingCopy } from '../working/working-copy.ts';
import type { OtherElement, OtherModel, OtherRel } from './read-file.ts';

/** An element of a change request, in `ElementOut`'s key order. */
export type CrElement = {
	id: string;
	type_name: string;
	properties: { [key: string]: Value };
	rev: number | bigint;
};

/** A relationship of a change request, in `RelationshipOut`'s key order. */
export type CrRelationship = {
	id: string;
	type_name: string;
	source_id: string;
	target_id: string;
	properties: { [key: string]: Value };
	rev: number | bigint;
};

export type CrModified<E> = { id: string; before: E; after: E };

export type CrKindOps<E> = { added: E[]; modified: CrModified<E>[]; deleted: E[] };

/**
 * A change request's ops. Its property bags are the model's and the file's
 * own: it leaves through `crDocument`, which copies them, before the model
 * moves.
 */
export type Diff = { elements: CrKindOps<CrElement>; relationships: CrKindOps<CrRelationship> };

/** Entities visited per step. */
const STEP_ENTITIES = 2048;

/** A working element as a change request lists it, sharing its property bag. */
export const workingElement = (rec: ElementRec): CrElement => ({
	id: rec.id,
	type_name: rec.typeName,
	properties: rec.props,
	rev: rec.rev
});

const otherElement = (e: OtherElement): CrElement => ({
	id: e.id,
	type_name: e.typeName,
	properties: e.props,
	rev: e.rev
});

/** A working relationship as a change request lists it, sharing its property bag. */
export const workingRel = (rec: RelRec): CrRelationship => ({
	id: rec.id,
	type_name: rec.typeName,
	source_id: rec.source.id,
	target_id: rec.target.id,
	properties: rec.props,
	rev: rec.rev
});

const otherRel = (r: OtherRel): CrRelationship => ({
	id: r.id,
	type_name: r.typeName,
	source_id: r.sourceId,
	target_id: r.targetId,
	properties: r.props,
	rev: r.rev
});

/** `rev` is ignored: an entity matches on its type, its properties and, for a relationship, its ends. */
const elementMatches = (a: ElementRec, b: OtherElement): boolean =>
	a.typeName === b.typeName && pyEq(a.props, b.props);

const relMatches = (a: RelRec, b: OtherRel): boolean =>
	a.typeName === b.typeName &&
	a.source.id === b.sourceId &&
	a.target.id === b.targetId &&
	pyEq(a.props, b.props);

/**
 * The working copy against `other`, identity by id per kind: added and
 * modified in the file's order, deleted in the working copy's, elements
 * first; a step every 2,048 entities visited. It iterates the working model
 * across its yields, so the model must not move between them; a scan
 * guarantees that.
 */
export function* diffSteps(wc: WorkingCopy, other: OtherModel): Steps<Diff> {
	const { model } = wc;
	const meter = new Meter(
		other.elements.size + other.relationships.size + model.elementCount + model.relationshipCount,
		STEP_ENTITIES
	);
	const diff: Diff = {
		elements: { added: [], modified: [], deleted: [] },
		relationships: { added: [], modified: [], deleted: [] }
	};

	for (const e of other.elements.values()) {
		const base = model.findElement(e.id);
		if (base === undefined) diff.elements.added.push(otherElement(e));
		else if (!elementMatches(base, e)) {
			diff.elements.modified.push({
				id: e.id,
				before: workingElement(base),
				after: otherElement(e)
			});
		}
		if (meter.tick()) yield meter.end();
	}
	for (const base of model.elements()) {
		if (!other.elements.has(base.id)) diff.elements.deleted.push(workingElement(base));
		if (meter.tick()) yield meter.end();
	}

	for (const r of other.relationships.values()) {
		const base = model.findRelationship(r.id);
		if (base === undefined) diff.relationships.added.push(otherRel(r));
		else if (!relMatches(base, r)) {
			diff.relationships.modified.push({ id: r.id, before: workingRel(base), after: otherRel(r) });
		}
		if (meter.tick()) yield meter.end();
	}
	for (const base of model.relationships()) {
		if (!other.relationships.has(base.id)) diff.relationships.deleted.push(workingRel(base));
		if (meter.tick()) yield meter.end();
	}
	return diff;
}
