// The display "name" of an element/relationship lives in its free-form
// `properties` bag. The conventional key is `name`, but source models often
// use other casings (`Name`, `NAME`, ...), so detection is case-insensitive.

/**
 * The non-empty string `name` property of a properties bag, looked up
 * case-insensitively (`name`, `Name`, `NAME`, ...). An exact lowercase `name`
 * wins over other casings; otherwise the first non-empty string match is used.
 * Returns `undefined` when no usable name property exists.
 */
export function nameProp(props: Record<string, unknown> | null | undefined): string | undefined {
	if (!props) return undefined;
	const exact = props.name;
	if (typeof exact === 'string' && exact.length > 0) return exact;
	for (const key in props) {
		if (key !== 'name' && key.toLowerCase() === 'name') {
			const v = props[key];
			if (typeof v === 'string' && v.length > 0) return v;
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
