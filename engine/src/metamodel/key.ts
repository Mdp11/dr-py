/** A relationship named by an element type's key: `out:<RelType>` or `in:<RelType>`. */
export type KeyRel = { relType: string; direction: 'out' | 'in' };

/** An element type's effective key, split into its property and relationship parts. */
export type KeySpec = { properties: string[]; relationships: KeyRel[] };

/** `out:R` and `in:R` are relationship keys; any other entry is a property name. */
export function parseKeyEntry(entry: string): string | KeyRel {
	if (entry.startsWith('out:')) return { relType: entry.slice(4), direction: 'out' };
	if (entry.startsWith('in:')) return { relType: entry.slice(3), direction: 'in' };
	return entry;
}

/** Declaration order is kept within each part. */
export function parseKey(entries: readonly string[]): KeySpec {
	const spec: KeySpec = { properties: [], relationships: [] };
	for (const entry of entries) {
		const parsed = parseKeyEntry(entry);
		if (typeof parsed === 'string') spec.properties.push(parsed);
		else spec.relationships.push(parsed);
	}
	return spec;
}
