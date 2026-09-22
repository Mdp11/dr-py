// A small registry of "is anything still in flight that a read might race?"
// probes: shadow's re-test waits for `quiet()` before asking again, so a
// difference caused by the model catching up to a commit is not reported as
// a mismatch.

const probes = new Set<() => Promise<void>>();

/** Registers a probe `quiet()` awaits; returns the function that removes it. */
export function addQuietProbe(probe: () => Promise<void>): () => void {
	probes.add(probe);
	return () => probes.delete(probe);
}

/** Resolves once every registered probe has resolved. No probes: resolves at once. */
export async function quiet(): Promise<void> {
	await Promise.all([...probes].map((probe) => probe()));
}
