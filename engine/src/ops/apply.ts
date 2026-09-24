import { errorDetail, ModelError } from '../model/errors.ts';
import { findArrayIndexKey, TEMP_ID_PREFIX } from '../model/load.ts';
import type { Model } from '../model/model.ts';
import { ElementRec, getProp, setProp, type Props, type RelRec } from '../model/records.ts';
import type { DirtyCollector } from '../validation/dirty.ts';
import { cmpCodePoint } from '../value/compare.ts';
import { pyRepr } from '../value/repr.ts';
import type { Value } from '../value/types.ts';
import { OpError } from './errors.ts';
import { resolveProps } from './resolve.ts';
import { BatchResult } from './result.ts';
import { rewind } from './rewind.ts';
import type { CreateElementOp, CreateRelationshipOp, ModelOp } from './types.ts';

export type ApplyOptions = {
	/** A create op whose `temp_id` lacks the temp prefix names the exact id to reinstate. */
	restore?: boolean;
	/**
	 * The id of an entity created under a temp id. The identity when absent: a
	 * staged entity lives under its temp id until the server mints the real one.
	 */
	idFor?: (tempId: string) => string;
	/**
	 * Collects the ids whose validation verdict the batch may have changed,
	 * through the hooks the server's applier fires, at the same points. A
	 * refused batch leaves it holding ids of a batch that never happened.
	 */
	dirty?: DirtyCollector;
};

/** A JavaScript object cannot keep such a key in insertion order, so no op may carry one. */
function refuseIndexKeys(props: Props | undefined): void {
	const indexKey = props === undefined ? null : findArrayIndexKey(props);
	if (indexKey !== null) {
		throw new ModelError(
			'value',
			`Property key ${pyRepr(indexKey)} is an array index, ` +
				'which cannot keep its place in insertion order'
		);
	}
}

/** Unknown keys are refused up front, so that a patch never fails half applied. */
function checkPatchKeys(valid: ReadonlySet<string>, typeName: string, patch: Props): void {
	for (const key of Object.keys(patch)) {
		if (!valid.has(key)) {
			throw new ModelError('key', `${pyRepr(typeName)} has no property ${pyRepr(key)}`);
		}
	}
}

/** The replayed journal branches on the prefix, so a final id must never carry it. */
function rejectReservedHint(hint: string): void {
	if (hint.startsWith(TEMP_ID_PREFIX)) {
		throw new ModelError(
			'value',
			`id hint ${pyRepr(hint)} must not use the reserved ${pyRepr(TEMP_ID_PREFIX)} prefix`
		);
	}
}

/** The final id of a create op, by the prefix of its `temp_id`: hinted, minted, or reinstated. */
function createdId(
	op: CreateElementOp | CreateRelationshipOp,
	options: ApplyOptions
): { id: string; temp: boolean } {
	if (op.temp_id.startsWith(TEMP_ID_PREFIX)) {
		if (op.id === undefined || op.id === null) {
			return { id: options.idFor ? options.idFor(op.temp_id) : op.temp_id, temp: true };
		}
		rejectReservedHint(op.id);
		return { id: op.id, temp: true };
	}
	if (options.restore) return { id: op.temp_id, temp: false };
	throw new ModelError(
		'value',
		`${op.kind} temp_id ${pyRepr(op.temp_id)} must start with ${pyRepr(TEMP_ID_PREFIX)}`
	);
}

/**
 * The elements `deleteElement` would remove, the element first. Walked from a
 * stack, children by sorted relationship id: the order is part of the result.
 */
export function containmentClosure(model: Model, elementId: string): ElementRec[] {
	const root = model.getElement(elementId);
	const order = [root];
	const seen = new Set([root]);
	const stack = [root];
	while (stack.length > 0) {
		const element = stack.pop()!;
		const contained = element.out
			.filter((rel) => model.metamodel.isContainment(rel.typeName))
			.sort((a, b) => cmpCodePoint(a.id, b.id));
		for (const rel of contained) {
			if (seen.has(rel.target)) continue;
			seen.add(rel.target);
			order.push(rel.target);
			stack.push(rel.target);
		}
	}
	return order;
}

const byId = (a: RelRec, b: RelRec) => cmpCodePoint(a.id, b.id);

/** Writes one property, a `null` removing the key, between the hooks the server fires around it. */
function writeProp(
	model: Model,
	target: ElementRec | RelRec,
	key: string,
	value: Value,
	remove: boolean,
	dirty: DirtyCollector | undefined
): void {
	const isElement = dirty !== undefined && target instanceof ElementRec;
	if (isElement) dirty.beforeElementPropsChange(model, target.id);
	if (remove) model.deleteProperty(target, key);
	else model.setProperty(target, key, value);
	if (isElement) dirty.afterElementPropsChange(model, target.id);
	else dirty?.afterRelationshipPropsChange(target.id);
}

function applyPatch(
	model: Model,
	target: ElementRec | RelRec,
	patch: Props,
	dirty: DirtyCollector | undefined
): Props {
	// The inverse restores each prior value, and removes a key that was not there.
	const inverse: Props = {};
	for (const key of Object.keys(patch)) setProp(inverse, key, getProp(target.props, key) ?? null);
	for (const key of Object.keys(patch)) {
		const value = getProp(patch, key)!;
		writeProp(model, target, key, value, value === null, dirty);
	}
	return inverse;
}

/**
 * Applies one op, recording its inverse unit and what it touched. A unit is
 * recorded only for a mutation that happened, and a create's before its
 * properties are set, so whatever fails midway is covered by what is on record.
 */
function applyOne(model: Model, op: ModelOp, res: BatchResult, options: ApplyOptions): void {
	const resolve = (id: string) => res.idMap.get(id) ?? id;
	const dirty = options.dirty;
	switch (op.kind) {
		case 'create_element': {
			refuseIndexKeys(op.properties);
			const props = resolveProps(op.properties, res.idMap);
			const { id, temp } = createdId(op, options);
			const element = model.createElement(op.type_name, id);
			dirty?.afterElementCreate(model, element.id);
			if (temp) res.idMap.set(op.temp_id, element.id);
			res.noteElementBefore(element.id, null);
			res.inverseUnits.push([{ kind: 'delete_element', id: element.id }]);
			for (const key of Object.keys(props)) {
				writeProp(model, element, key, getProp(props, key)!, false, dirty);
			}
			res.markElementCreated(element.id);
			return;
		}
		case 'update_element': {
			const id = resolve(op.id);
			const element = model.getElement(id);
			res.noteElementBefore(id, element);
			refuseIndexKeys(op.properties_patch);
			const patch = resolveProps(op.properties_patch, res.idMap);
			const valid = model.metamodel.effectiveElementPropertyNames(element.typeName);
			checkPatchKeys(valid, element.typeName, patch);
			const inverse = applyPatch(model, element, patch, dirty);
			res.inverseUnits.push([{ kind: 'update_element', id, properties_patch: inverse }]);
			res.markElementChanged(id);
			return;
		}
		case 'delete_element': {
			const id = resolve(op.id);
			// The cascade is read before it happens: the containment closure, and
			// per closure element its outgoing then its incoming relationships.
			const closure = containmentClosure(model, id);
			const removed = new Set<RelRec>();
			for (const element of closure) {
				for (const rel of element.out.toSorted(byId)) removed.add(rel);
				for (const rel of element.in.toSorted(byId)) removed.add(rel);
			}
			// Elements come back before relationships: ends must exist first.
			const unit: ModelOp[] = [];
			for (const element of closure) {
				res.noteElementBefore(element.id, element);
				unit.push({
					kind: 'create_element',
					temp_id: element.id,
					type_name: element.typeName,
					properties: { ...element.props },
					id: null
				});
			}
			for (const rel of removed) {
				res.noteRelationshipBefore(rel.id, rel);
				unit.push(recreate(rel));
			}
			const keyed = dirty?.beforeElementDelete(model, id, closure);
			model.deleteElement(id);
			if (keyed !== undefined) dirty!.afterElementDelete(model, keyed);
			res.inverseUnits.push(unit);
			for (const element of closure) res.markElementDeleted(element.id);
			for (const rel of removed) res.markRelationshipDeleted(rel.id);
			return;
		}
		case 'create_relationship': {
			const sourceId = resolve(op.source_id);
			const targetId = resolve(op.target_id);
			refuseIndexKeys(op.properties);
			const props = resolveProps(op.properties, res.idMap);
			const { id, temp } = createdId(op, options);
			dirty?.beforeConnect(model, op.type_name, sourceId, targetId);
			const rel = model.connect(op.type_name, sourceId, targetId, id);
			dirty?.afterConnect(model, rel.id);
			if (temp) res.idMap.set(op.temp_id, rel.id);
			res.noteRelationshipBefore(rel.id, null);
			res.inverseUnits.push([{ kind: 'delete_relationship', id: rel.id }]);
			for (const key of Object.keys(props)) {
				writeProp(model, rel, key, getProp(props, key)!, false, dirty);
			}
			res.markRelationshipCreated(rel.id);
			return;
		}
		case 'update_relationship': {
			const id = resolve(op.id);
			const rel = model.getRelationship(id);
			res.noteRelationshipBefore(id, rel);
			refuseIndexKeys(op.properties_patch);
			const patch = resolveProps(op.properties_patch, res.idMap);
			const valid = model.metamodel.effectiveRelationshipPropertyNames(rel.typeName);
			checkPatchKeys(valid, rel.typeName, patch);
			const inverse = applyPatch(model, rel, patch, dirty);
			res.inverseUnits.push([{ kind: 'update_relationship', id, properties_patch: inverse }]);
			res.markRelationshipChanged(id);
			return;
		}
		case 'delete_relationship': {
			const id = resolve(op.id);
			const rel = model.getRelationship(id);
			res.noteRelationshipBefore(id, rel);
			const unit = [recreate(rel)];
			dirty?.beforeDisconnect(model, id);
			model.disconnect(id);
			dirty?.afterDisconnect(model, rel.typeName, rel.source.id, rel.target.id);
			res.inverseUnits.push(unit);
			res.markRelationshipDeleted(id);
			return;
		}
	}
}

function recreate(rel: RelRec): CreateRelationshipOp {
	return {
		kind: 'create_relationship',
		temp_id: rel.id,
		type_name: rel.typeName,
		source_id: rel.source.id,
		target_id: rel.target.id,
		properties: { ...rel.props },
		id: null
	};
}

/**
 * Applies `ops` to the model as one unit, with the server applier's semantics
 * and refusal texts. A refused batch leaves no trace: every touched entity is
 * put back as it was — `rev` and place in state order included — and an
 * `OpError` is thrown. Anything else that throws is a bug, and propagates
 * after the same rewind.
 */
export function applyBatch(
	model: Model,
	ops: readonly ModelOp[],
	options: ApplyOptions = {}
): BatchResult {
	const res = new BatchResult();
	try {
		for (const op of ops) applyOne(model, op, res, options);
	} catch (caught) {
		rewind(model, res);
		if (caught instanceof ModelError) throw new OpError(422, errorDetail(caught));
		throw caught;
	}
	return res;
}
