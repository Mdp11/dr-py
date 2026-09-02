/**
 * The ACTIVE view id — a per-client choice, remembered per project in
 * localStorage (`dr:view:<projectId>`), never shared with peers: two editors
 * may work in different views of the same project at once.
 *
 * A LEAF store (no store imports) on purpose: `edit-gate.ts` maps a root
 * lock target to the active view's `view:` lease and `checkout.svelte.ts`
 * releases it by the same mapping, and both sit UNDER `view.svelte.ts` in
 * the import graph — the id has to live somewhere all three can read
 * without a cycle. `view.svelte.ts` owns the transitions (`selectView`,
 * `loadViews`); everything else only reads.
 */

let _activeViewId: string | null = $state(null);

export function getActiveViewId(): string | null {
	return _activeViewId;
}

/** In-memory only — persistence is the caller's decision ({@link
 * rememberActiveViewId}), so a boot-time restore does not re-write the key. */
export function setActiveViewId(id: string | null): void {
	_activeViewId = id;
}

function storageKey(projectId: string): string {
	return `dr:view:${projectId}`;
}

/** The id remembered for `projectId`, or null (no choice yet, or storage
 * unavailable). A remembered id may name a view that no longer exists — the
 * caller reconciles against the live list. */
export function recallActiveViewId(projectId: string): string | null {
	try {
		return localStorage.getItem(storageKey(projectId));
	} catch {
		return null;
	}
}

/** Persist the choice for `projectId` (null forgets it). Best-effort:
 * storage failures are swallowed — the in-memory value already won. */
export function rememberActiveViewId(projectId: string, id: string | null): void {
	try {
		if (id === null) localStorage.removeItem(storageKey(projectId));
		else localStorage.setItem(storageKey(projectId), id);
	} catch {
		// private mode / quota — the choice just does not survive a reload
	}
}
