import { getProp, setProp, type Props } from '../model/records.ts';
import type { Value } from '../value/types.ts';

/** A string naming a mapped temp id becomes its id, in lists too; anything else stays as it is. */
export function resolveValue(value: Value, idMap: ReadonlyMap<string, string>): Value {
	if (typeof value === 'string') return idMap.get(value) ?? value;
	if (Array.isArray(value)) return value.map((item) => resolveValue(item, idMap));
	return value;
}

/** A new bag, keys in the same order, values resolved. */
export function resolveProps(props: Props | undefined, idMap: ReadonlyMap<string, string>): Props {
	const out: Props = {};
	if (props === undefined) return out;
	for (const key of Object.keys(props)) {
		setProp(out, key, resolveValue(getProp(props, key)!, idMap));
	}
	return out;
}
