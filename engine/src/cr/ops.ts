/**
 * `ops_for_change`: the op batch that lands a change request, in the order
 * that keeps the two equivalent under the applier: element creates,
 * relationship creates (ends on created elements as their temp ids), element
 * updates, relationship updates, relationship deletes, rewires as a delete
 * and a create under the same id, element deletes.
 */
import { setProp, type Props } from '../model/records.ts';
import { TEMP_ID_PREFIX } from '../model/load.ts';
import { ReadError } from '../read/errors.ts';
import type { Wire } from '../read/wire.ts';
import { pyEq } from '../value/eq.ts';
import { pyRepr } from '../value/repr.ts';
import type { CrElement, CrRelationship, Diff } from './diff.ts';
import { crWire } from './document.ts';

/** An op as the route answers it, in its schema's key order. */
export type WireOp = { [key: string]: Wire };

/** `_diff_to_merge_patch`: after's changed keys in after's order, then before's removed keys as `null`. */
function mergePatch(before: Props, after: Props): Props {
	const patch: Props = {};
	for (const key of Object.keys(after)) {
		if (!Object.hasOwn(before, key) || !pyEq(before[key]!, after[key]!)) {
			setProp(patch, key, after[key]!);
		}
	}
	for (const key of Object.keys(before)) {
		if (!Object.hasOwn(after, key)) setProp(patch, key, null);
	}
	return patch;
}

const isRewire = (before: CrRelationship, after: CrRelationship): boolean =>
	before.source_id !== after.source_id ||
	before.target_id !== after.target_id ||
	before.type_name !== after.type_name;

const hasKeys = (props: Props): boolean => Object.keys(props).length > 0;

/**
 * The ops for `diff`, values as the route writes them. A modified element
 * whose type changes has no op: it is refused, before any op is made.
 */
export function opsForChange(diff: Diff): WireOp[] {
	const elementPatches: [string, Props][] = [];
	for (const { id, before, after } of diff.elements.modified) {
		if (before.type_name !== after.type_name) {
			throw new ReadError(
				422,
				`Element ${pyRepr(id)} changes type (${pyRepr(before.type_name)} -> ` +
					`${pyRepr(after.type_name)}); element type changes are not supported — ` +
					'delete and re-create it in the CR'
			);
		}
		const patch = mergePatch(before.properties, after.properties);
		if (hasKeys(patch)) elementPatches.push([id, patch]);
	}

	const ops: WireOp[] = [];
	// Only element ids are ends; one counter serves both kinds.
	const tempOf = new Map<string, string>();
	let counter = 0;
	const nextTemp = () => `${TEMP_ID_PREFIX}${++counter}`;
	const ref = (id: string) => tempOf.get(id) ?? id;

	const createElement = (e: CrElement): WireOp => {
		const tempId = nextTemp();
		tempOf.set(e.id, tempId);
		return {
			kind: 'create_element',
			temp_id: tempId,
			type_name: e.type_name,
			properties: crWire(e.properties),
			id: e.id
		};
	};
	const createRelationship = (r: CrRelationship): WireOp => ({
		kind: 'create_relationship',
		temp_id: nextTemp(),
		type_name: r.type_name,
		source_id: ref(r.source_id),
		target_id: ref(r.target_id),
		properties: crWire(r.properties),
		id: r.id
	});

	for (const e of diff.elements.added) ops.push(createElement(e));
	for (const r of diff.relationships.added) ops.push(createRelationship(r));
	for (const [id, patch] of elementPatches) {
		ops.push({ kind: 'update_element', id, properties_patch: crWire(patch) });
	}
	const rewires: { id: string; after: CrRelationship }[] = [];
	for (const { id, before, after } of diff.relationships.modified) {
		if (isRewire(before, after)) {
			rewires.push({ id, after });
			continue;
		}
		const patch = mergePatch(before.properties, after.properties);
		if (hasKeys(patch))
			ops.push({ kind: 'update_relationship', id, properties_patch: crWire(patch) });
	}
	for (const r of diff.relationships.deleted) ops.push({ kind: 'delete_relationship', id: r.id });
	for (const { id, after } of rewires) {
		ops.push({ kind: 'delete_relationship', id });
		ops.push(createRelationship(after));
	}
	for (const e of diff.elements.deleted) ops.push({ kind: 'delete_element', id: e.id });
	return ops;
}
