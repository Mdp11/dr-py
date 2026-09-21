import type { ElementRec, RelRec } from '../model/records.ts';
import type { ModelOp } from '../ops/types.ts';
import type { ElementImage, RelImage } from '../ops/result.ts';
import { parseJson } from '../value/parse.ts';
import { PyFloat, type Value } from '../value/types.ts';
import { ReadError } from './errors.ts';

/** JSON-able data, as a response body carries it. */
export type Wire = null | boolean | number | string | Wire[] | { [key: string]: Wire };

export type WireElement = {
	id: string;
	type_name: string;
	properties: { [key: string]: Wire };
	rev: number;
};

export type WireRelationship = {
	id: string;
	type_name: string;
	source_id: string;
	target_id: string;
	properties: { [key: string]: Wire };
	rev: number;
};

/**
 * A deep copy of `value` as plain JSON-able data: a float leaves as its
 * number and an integer past 2^53 as the nearest double — what a client's
 * `JSON.parse` of the server's body gives. Nothing of the replica leaves.
 */
export function toWire(value: Value): Wire {
	if (value instanceof PyFloat) return value.value;
	if (typeof value === 'bigint') return Number(value);
	if (Array.isArray(value)) return value.map(toWire);
	if (typeof value === 'object' && value !== null) return wireObject(value);
	return value;
}

function wireObject(value: { [key: string]: Value }): { [key: string]: Wire } {
	const out: { [key: string]: Wire } = {};
	for (const key of Object.keys(value)) {
		// An own `__proto__` key stays an own key.
		Object.defineProperty(out, key, {
			value: toWire(value[key]!),
			writable: true,
			enumerable: true,
			configurable: true
		});
	}
	return out;
}

export const wireElement = (rec: ElementRec): WireElement => ({
	id: rec.id,
	type_name: rec.typeName,
	properties: wireObject(rec.props),
	rev: rec.rev
});

export const wireRelationship = (rec: RelRec): WireRelationship => ({
	id: rec.id,
	type_name: rec.typeName,
	source_id: rec.source.id,
	target_id: rec.target.id,
	properties: wireObject(rec.props),
	rev: rec.rev
});

export const wireElementImage = (image: ElementImage): WireElement => ({
	id: image.id,
	type_name: image.typeName,
	properties: wireObject(image.props),
	rev: image.rev
});

export const wireRelImage = (image: RelImage): WireRelationship => ({
	id: image.id,
	type_name: image.typeName,
	source_id: image.sourceId,
	target_id: image.targetId,
	properties: wireObject(image.props),
	rev: image.rev
});

type Doc = { [key: string]: Value };

const isDoc = (value: Value | undefined): value is Doc =>
	typeof value === 'object' &&
	value !== null &&
	!Array.isArray(value) &&
	!(value instanceof PyFloat);

function refuse(where: string, message: string): never {
	throw new ReadError(422, `${where}: ${message}`);
}

function str(op: Doc, key: string, where: string): string {
	const value = Object.hasOwn(op, key) ? op[key] : undefined;
	if (typeof value !== 'string') refuse(`${where}.${key}`, 'must be a string');
	return value;
}

function props(op: Doc, key: string, where: string, required: boolean): Doc | undefined {
	const value = Object.hasOwn(op, key) ? op[key] : undefined;
	if (value === undefined && !required) return undefined;
	if (!isDoc(value)) refuse(`${where}.${key}`, 'must be an object');
	return value;
}

function hint(op: Doc, where: string): { id?: string | null } {
	if (!Object.hasOwn(op, 'id')) return {};
	const id = op['id'];
	if (id !== null && typeof id !== 'string') refuse(`${where}.id`, 'must be a string or null');
	return { id: id as string | null };
}

const OP_KINDS = [
	'create_element',
	'update_element',
	'delete_element',
	'create_relationship',
	'update_relationship',
	'delete_relationship'
];

function readOp(doc: Value, where: string): ModelOp {
	if (!isDoc(doc)) refuse(where, 'must be an object');
	const kind = Object.hasOwn(doc, 'kind') ? doc['kind'] : undefined;
	switch (kind) {
		case 'create_element': {
			const properties = props(doc, 'properties', where, false);
			return {
				kind,
				temp_id: str(doc, 'temp_id', where),
				type_name: str(doc, 'type_name', where),
				...(properties === undefined ? {} : { properties }),
				...hint(doc, where)
			};
		}
		case 'create_relationship': {
			const properties = props(doc, 'properties', where, false);
			return {
				kind,
				temp_id: str(doc, 'temp_id', where),
				type_name: str(doc, 'type_name', where),
				source_id: str(doc, 'source_id', where),
				target_id: str(doc, 'target_id', where),
				...(properties === undefined ? {} : { properties }),
				...hint(doc, where)
			};
		}
		case 'update_element':
		case 'update_relationship':
			return {
				kind,
				id: str(doc, 'id', where),
				properties_patch: props(doc, 'properties_patch', where, true)!
			};
		case 'delete_element':
		case 'delete_relationship':
			return { kind, id: str(doc, 'id', where) };
	}
	return refuse(`${where}.kind`, `must be one of ${OP_KINDS.join(', ')}`);
}

/**
 * Ops as the client would send them, read as the server reads them: through
 * `JSON.stringify` — an integral double becomes an `int`, `NaN` `null`, `-0`
 * `0` — and the exact parser. A malformed op refuses the whole list.
 */
export function readOps(raw: unknown): ModelOp[] {
	if (!Array.isArray(raw)) refuse('ops', 'must be a list');
	let docs: Value;
	try {
		docs = parseJson(JSON.stringify(raw));
	} catch (caught) {
		return refuse('ops', `not JSON: ${(caught as Error).message}`);
	}
	return (docs as Value[]).map((doc, i) => readOp(doc, `ops[${i}]`));
}
