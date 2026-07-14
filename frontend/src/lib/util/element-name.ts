// The display "name" of an element/relationship lives in its free-form
// `properties` bag. The conventional key is `name`, but source models often
// use other casings (`Name`, `NAME`, ...), so detection is case-insensitive.

/** A usable name out of a property value: the string itself, or — for a
 * multiplicity-many `name` (a list, e.g. from a migrated legacy model) — the
 * first non-empty string entry. Mirrors the backend's `naming._name_str`. */
function nameStr(value: unknown): string | undefined {
	if (typeof value === 'string' && value.length > 0) return value;
	if (Array.isArray(value)) {
		for (const v of value) {
			if (typeof v === 'string' && v.length > 0) return v;
		}
	}
	return undefined;
}

/**
 * The non-empty string `name` property of a properties bag, looked up
 * case-insensitively (`name`, `Name`, `NAME`, ...). An exact lowercase `name`
 * wins over other casings; otherwise the first non-empty string match is used.
 * List values (multiplicity-many names) contribute their first non-empty
 * string entry. Returns `undefined` when no usable name property exists.
 */
export function nameProp(props: Record<string, unknown> | null | undefined): string | undefined {
	if (!props) return undefined;
	const exact = nameStr(props.name);
	if (exact !== undefined) return exact;
	for (const key in props) {
		if (key !== 'name' && key.toLowerCase() === 'name') {
			const v = nameStr(props[key]);
			if (v !== undefined) return v;
		}
	}
	return undefined;
}

/** An element's display name (case-insensitive `name` property), falling back
 * to its id when no name property is set. */
export function elementDisplayName(el: {
	id: string;
	properties: Record<string, unknown>;
}): string {
	return nameProp(el.properties) ?? el.id;
}
