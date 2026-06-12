/**
 * Shallow-merge `patch` into `base`. Keys set to `null` in the patch are
 * removed from the result. All other keys are overwritten.
 *
 * Mirrors the backend's op-batch merge-patch semantics; the delta-protocol
 * store (`model.svelte.ts`) applies it optimistically. (The old
 * clone-the-world `apply(baseline, ops)` working-model recompute that lived
 * here was deleted with the baseline/pending stores in Phase D2.)
 */
export function mergePatch(
	base: Record<string, unknown>,
	patch: Record<string, unknown>
): Record<string, unknown> {
	const out: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) {
			delete out[key];
		} else {
			out[key] = value;
		}
	}
	return out;
}
