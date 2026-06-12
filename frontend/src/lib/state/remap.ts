/**
 * Temp-id remapping helpers shared by the snapshot save path (`save.ts`) and
 * the delta-protocol model store (`model.svelte.ts`).
 *
 * Both helpers are change-tracking: when nothing referenced a mapped id they
 * return the ORIGINAL value (same reference), so callers can use reference
 * equality to detect "nothing changed" and skip writes (e.g. avoid churning
 * Svelte subscriptions on cached entities an id_map never touched).
 */

/** Remap ref-shaped property values: strings and (nested) arrays of them. */
export function remapValue(value: unknown, mapping: Record<string, string>): unknown {
	if (typeof value === 'string') return mapping[value] ?? value;
	if (Array.isArray(value)) {
		const mapped = value.map((v) => remapValue(v, mapping));
		return mapped.some((v, i) => v !== value[i]) ? mapped : value;
	}
	return value;
}

export function remapProperties(
	props: Record<string, unknown>,
	mapping: Record<string, string>
): Record<string, unknown> {
	let out: Record<string, unknown> | null = null;
	for (const [k, v] of Object.entries(props)) {
		const mapped = remapValue(v, mapping);
		if (mapped !== v && out === null) out = { ...props };
		if (out !== null) out[k] = mapped;
	}
	return out ?? props;
}
