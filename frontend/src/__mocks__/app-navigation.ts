/** Stub for $app/navigation used in vitest (no SvelteKit runtime in tests).
 * Exports the minimal surface used by components under test; override per-test
 * with vi.mock('$app/navigation', ...).
 */
export async function goto(): Promise<void> {
	// no-op; override with vi.mock in component tests
}

export function invalidate(): Promise<void> {
	return Promise.resolve();
}

export function invalidateAll(): Promise<void> {
	return Promise.resolve();
}
