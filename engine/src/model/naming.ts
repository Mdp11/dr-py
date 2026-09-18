import type { Value } from '../value/types.ts';
import { getProp, type ElementRec } from './records.ts';

/** A non-empty string, or the first non-empty string of a list. */
function nameStr(value: Value | undefined): string | null {
	if (typeof value === 'string') return value === '' ? null : value;
	if (Array.isArray(value)) {
		for (const item of value) if (typeof item === 'string' && item !== '') return item;
	}
	return null;
}

/**
 * The element's `name`, or `null`. An exact lower-case `name` wins over any
 * other casing (`Name`, `NAME`), which are tried in property order.
 */
export function nameOf(element: ElementRec): string | null {
	const exact = nameStr(getProp(element.props, 'name'));
	if (exact !== null) return exact;
	for (const key of Object.keys(element.props)) {
		if (key !== 'name' && key.toLowerCase() === 'name') {
			const found = nameStr(element.props[key]);
			if (found !== null) return found;
		}
	}
	return null;
}

/** The element's name, else its id. Root order sorts by this. */
export function displayName(element: ElementRec): string {
	return nameOf(element) ?? element.id;
}
