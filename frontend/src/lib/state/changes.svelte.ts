// Server-side change set (GET /model/changes*) mirrored for the UI.
//
// The badge counts that drive the TopBar "Save (N)" label and the StatusBar
// "N unsaved" indicator come from /model/changes/summary; the DiffDrawer's
// row list comes from the full /model/changes document, mapped onto the
// `EntityDiff` shape `DiffRow.svelte` already renders.
//
// Refresh policy: `TopBar` re-fetches the summary whenever the store's
// `model_rev` changes (i.e. after every acknowledged ops batch / undo /
// apply-cr) and after load flows clear it. NOTE: the change set is relative
// to the model as LOADED into the session — saving to a file does not reset
// it (the backend op log has no "mark saved" notion), which is a deliberate
// departure from the old client-diff counter that reset on save.

import type { ChangesDoc, ChangesSummary, Element, Relationship } from '$lib/api/types';
import type { ClientConfig } from '$lib/api/client';
import { getChangesSummary } from '../api/model-read';
import { deepEqual, type Diff, type EntityDiff } from './diff';

let _badge: ChangesSummary | null = $state(null);

/** Test/dev hook mirroring `setModelApiConfig` in model.svelte.ts. */
let _clientConfig: ClientConfig | undefined;

export function setChangesApiConfig(cfg: ClientConfig | undefined): void {
	_clientConfig = cfg;
}

/** Latest fetched /model/changes/summary, or null (no model / not fetched). */
export function getChangesBadge(): ChangesSummary | null {
	return _badge;
}

/** Total changed entities in the compacted change set (0 when unknown). */
export function getChangesBadgeTotal(): number {
	if (_badge === null) return 0;
	return _badge.adds + _badge.modifies + _badge.deletes;
}

export async function refreshChangesBadge(): Promise<void> {
	_badge = await getChangesSummary(_clientConfig);
}

export function clearChangesBadge(): void {
	_badge = null;
}

// ---------------------------------------------------------------------------
// ChangesDoc -> Diff (the shape DiffRow.svelte renders)
// ---------------------------------------------------------------------------

function modifiedFieldsOf(before: Element | Relationship, after: Element | Relationship): string[] {
	const keys = new Set<string>([
		...Object.keys(before.properties),
		...Object.keys(after.properties)
	]);
	const out: string[] = [];
	for (const k of keys) {
		if (!deepEqual(before.properties[k], after.properties[k])) out.push(k);
	}
	if ('source_id' in before && 'source_id' in after) {
		if (before.source_id !== after.source_id) out.push('source_id');
		if (before.target_id !== after.target_id) out.push('target_id');
	}
	return out;
}

function sectionToDiffs(section: {
	added: (Element | Relationship)[];
	modified: { id: string; before: Element | Relationship; after: Element | Relationship }[];
	deleted: (Element | Relationship)[];
}): EntityDiff[] {
	const out: EntityDiff[] = [];
	for (const e of section.added) out.push({ id: e.id, status: 'added', after: e });
	for (const m of section.modified) {
		out.push({
			id: m.id,
			status: 'modified',
			before: m.before,
			after: m.after,
			modifiedFields: modifiedFieldsOf(m.before, m.after)
		});
	}
	for (const e of section.deleted) out.push({ id: e.id, status: 'deleted', before: e });
	return out;
}

/** Map a server /model/changes document onto the `Diff` shape the drawer renders. */
export function changesDocToDiff(doc: ChangesDoc): Diff {
	const elements = sectionToDiffs(doc.ops.elements);
	const relationships = sectionToDiffs(doc.ops.relationships);
	const counts = { added: 0, modified: 0, deleted: 0 };
	for (const d of [...elements, ...relationships]) {
		if (d.status === 'added') counts.added++;
		else if (d.status === 'modified') counts.modified++;
		else if (d.status === 'deleted') counts.deleted++;
	}
	return { elements, relationships, counts };
}
