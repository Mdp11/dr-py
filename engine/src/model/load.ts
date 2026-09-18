import { pyRepr } from '../value/repr.ts';
import { PyFloat, type Value } from '../value/types.ts';
import { SnapshotError } from './errors.ts';
import type { Props } from './records.ts';

/** The ops protocol's provisional ids; a stored entity never carries one. */
export const TEMP_ID_PREFIX = 'tmp_';

type Dict = { [key: string]: Value };

function isDict(value: Value | undefined): value is Dict {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		!(value instanceof PyFloat)
	);
}

/** One snapshot line as an object; `where` names it in every message (`elements[3]`). */
export function asEntity(doc: Value, where: string): Dict {
	if (!isDict(doc)) throw new SnapshotError(`${where}: must be an object`);
	return doc;
}

export function requireStr(entity: Dict, key: string, where: string): string {
	const value = Object.hasOwn(entity, key) ? entity[key] : undefined;
	if (typeof value !== 'string') {
		throw new SnapshotError(`${where}: field ${pyRepr(key)} must be a string`);
	}
	return value;
}

// A JavaScript object lists its array-index keys first, in numeric order,
// whatever order they were added in, so it cannot hold one in insertion order.
const ARRAY_INDEX = /^(?:0|[1-9]\d{0,9})$/;

function isArrayIndex(key: string): boolean {
	const first = key.charCodeAt(0);
	if (!(first >= 48 && first <= 57)) return false;
	return ARRAY_INDEX.test(key) && Number(key) < 4294967295;
}

/** The first key, at any depth of `value`, that a JavaScript object would list out of insertion order. */
export function findArrayIndexKey(value: Value): string | null {
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = findArrayIndexKey(item);
			if (found !== null) return found;
		}
	} else if (isDict(value)) {
		for (const key of Object.keys(value)) {
			if (isArrayIndex(key)) return key;
			const found = findArrayIndexKey(value[key]!);
			if (found !== null) return found;
		}
	}
	return null;
}

/** The entity's property bag, adopted as it is; an absent or `null` one is empty. */
export function readProps(entity: Dict, where: string): Props {
	const props = Object.hasOwn(entity, 'properties') ? entity['properties'] : null;
	if (props === null || props === undefined) return {};
	if (!isDict(props)) throw new SnapshotError(`${where}: field 'properties' must be an object`);
	const indexKey = findArrayIndexKey(props);
	if (indexKey !== null) {
		throw new SnapshotError(
			`${where}: property key ${pyRepr(indexKey)} is an array index, ` +
				'which cannot keep its place in insertion order'
		);
	}
	return props;
}

/** The entity's `rev`; absent means 0. A float or a boolean is not an integer. */
export function readRev(entity: Dict, where: string): number {
	const rev = Object.hasOwn(entity, 'rev') ? entity['rev'] : 0;
	if (typeof rev !== 'number') {
		throw new SnapshotError(`${where}: field 'rev' must be an integer`);
	}
	return rev;
}
