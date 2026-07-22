/**
 * Pure derivation of the sidebar "Staged elements" section rows from the
 * staged-edits diff (`getStagedDiff()`) plus the display caches. Element-id
 * centric: one row per element touched by staged ops — created (temp id),
 * modified (property edits OR appearing as an endpoint of any staged
 * relationship change), or deleted. Deleted rows read name/type from the
 * diff's `before` snapshot (the element is gone from the cache after the
 * optimistic apply). Kept free of store imports so it is trivially
 * unit-testable; StagedSection.svelte wires it to the live stores.
 */
import type { Element, Relationship, TreeItem } from '$lib/api/types';
import type { Diff } from './diff';
import { isTempId } from './ops';
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

export function deriveStagedElementRows(
	diff: Diff,
	elements: ReadonlyMap<string, Element>,
	treeItems: ReadonlyMap<string, TreeItem>
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

	// Endpoint rule: an element touched only by staged relationship changes
	// counts as modified. `after ?? before` covers created/updated rels (cache
	// state) and deleted/cascade-journal entries (before snapshot) alike.
	// First-write-wins via `status.has` so a deleted element never downgrades.
	for (const d of diff.relationships) {
		// `d` comes from diff.relationships, so before/after are always
		// Relationship snapshots (never Element) — the cast just recovers what
		// the shared EntityDiff.before/after union type erases.
		const r = (d.after ?? d.before) as Relationship | undefined;
		if (r === undefined) continue;
		for (const end of [r.source_id, r.target_id]) {
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
