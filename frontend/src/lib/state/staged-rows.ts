/**
 * Pure derivation of the sidebar "Staged elements" section rows from the
 * staged-edits diff (`getStagedDiff()`) plus the display caches. Element-id
 * centric: one row per element touched by staged ops — created (temp id),
 * modified (property edits OR appearing as an endpoint of a staged
 * relationship OP — see {@link stagedRelationshipOpIds}), or deleted. Deleted
 * rows read name/type from the diff's `before` snapshot (the element is gone
 * from the cache after the
 * optimistic apply). Kept free of store imports so it is trivially
 * unit-testable; StagedSection.svelte wires it to the live stores.
 */
import type { Element, Relationship, TreeItem } from '$lib/api/types';
import type { Diff } from './diff';
import { isTempId, type Op } from './ops';
import { elementDisplayName } from '$lib/util/element-name';

export type StagedRowStatus = 'new' | 'modified' | 'deleted';

export interface StagedElementRow {
	id: string;
	status: StagedRowStatus;
	displayName: string;
	/** null → display data unavailable in either cache; the section
	 * lite-fetches these ids via ensureTreeItems and re-derives when they
	 * land. */
	typeName: string | null;
}

const STATUS_RANK: Record<StagedRowStatus, number> = { new: 0, modified: 1, deleted: 2 };

/**
 * The relationship ids a staged relationship OP actually names — the input to
 * {@link deriveStagedElementRows}'s endpoint rule.
 *
 * Why this can't be read off `diff.relationships`: `getStagedDiff()` also
 * synthesises entries for relationships that a `delete_element` CASCADE tore
 * out (they show up as journal targets with no op of their own). Treating
 * those as staged relationship changes would badge the far endpoint of every
 * cascade-deleted rel as "edited" — a row whose revert button is a permanent
 * no-op, since no staged op targets that element. The spec defines Modified as
 * an endpoint of a staged relationship *op*, so the op buffer is the authority
 * and this set is the filter.
 */
export function stagedRelationshipOpIds(ops: readonly Op[]): Set<string> {
	// Plain Set: computation scratch, never read reactively (and this is a plain
	// .ts module, so the svelte reactivity lint doesn't apply).
	const ids = new Set<string>();
	for (const op of ops) {
		if (op.kind === 'create_relationship') ids.add(op.temp_id);
		else if (op.kind === 'update_relationship' || op.kind === 'delete_relationship') ids.add(op.id);
	}
	return ids;
}

/** `'source_id' in x` as a predicate. Element has no `source_id`, so the plain
 * `in` check narrows to `Relationship | (Element & Record<'source_id',
 * unknown>)` — typed enough to reject a bare `Relationship` assignment but not
 * enough to read endpoints from. A predicate keeps the runtime guard while
 * giving the caller the type it actually needs. */
function isRelationship(snap: Element | Relationship): snap is Relationship {
	return 'source_id' in snap;
}

export function deriveStagedElementRows(
	diff: Diff,
	elements: ReadonlyMap<string, Element>,
	treeItems: ReadonlyMap<string, TreeItem>,
	stagedRelIds: ReadonlySet<string>
): StagedElementRow[] {
	// Computation scratch rebuilt per call, never read reactively. (This is a
	// plain .ts module with no runes, so the svelte/prefer-svelte-reactivity
	// rule — which only applies to .svelte.ts files — doesn't fire here; plain
	// Map is correct and needs no eslint-disable.)
	const status = new Map<string, StagedRowStatus>();
	const deletedBefore = new Map<string, Element>();

	for (const d of diff.elements) {
		if (d.status === 'added') status.set(d.id, 'new');
		else if (d.status === 'modified') status.set(d.id, 'modified');
		else if (d.status === 'deleted') {
			// A temp element deleted in the same buffer is a net no-op (the diff
			// reports it deleted only because the delete's journal snapshot
			// captured the optimistically-created state) — hide it entirely.
			if (isTempId(d.id)) continue;
			status.set(d.id, 'deleted');
			if (d.before !== undefined) deletedBefore.set(d.id, d.before as Element);
		}
	}

	// Endpoint rule: an element touched only by staged relationship OPS counts
	// as modified. Restricted to `stagedRelIds` so cascade-journal entries (rels
	// torn out by a delete_element) don't badge their far endpoint as edited —
	// nothing staged targets it, so its revert button would be a dead control.
	// `after ?? before` covers created/updated rels (cache state) and deleted
	// ones (before snapshot) alike. First-write-wins via `status.has` so a
	// deleted element never downgrades.
	for (const d of diff.relationships) {
		if (!stagedRelIds.has(d.id)) continue;
		// EntityDiff.before/after is the shared Element|Relationship union, which
		// erases which side a relationships-list entry came from. isRelationship
		// is a REAL runtime narrowing (a bare `as Relationship` would let an
		// element-shaped snapshot through with undefined endpoints).
		const snap = d.after ?? d.before;
		if (snap === undefined || !isRelationship(snap)) continue;
		for (const end of [snap.source_id, snap.target_id]) {
			if (isTempId(end) || status.has(end)) continue;
			status.set(end, 'modified');
		}
	}

	const rows: StagedElementRow[] = [];
	for (const [id, st] of status) {
		if (st === 'deleted') {
			const before = deletedBefore.get(id);
			rows.push({
				id,
				status: st,
				displayName: before !== undefined ? elementDisplayName(before) : id,
				typeName: before?.type_name ?? null
			});
			continue;
		}
		const full = elements.get(id);
		if (full !== undefined) {
			rows.push({
				id,
				status: st,
				displayName: elementDisplayName(full),
				typeName: full.type_name
			});
			continue;
		}
		const liteRow = treeItems.get(id);
		rows.push({
			id,
			status: st,
			displayName: liteRow?.display_name ?? id,
			typeName: liteRow?.type_name ?? null
		});
	}

	rows.sort(
		(a, b) =>
			STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.displayName.localeCompare(b.displayName)
	);
	return rows;
}
