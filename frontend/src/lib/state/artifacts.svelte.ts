/**
 * Project-artifact library (Stage 1: saved navigations). Holds HEADERS only —
 * payloads are fetched by whichever editor opens the artifact. Kept fresh by
 * `artifact` feed events (peers' creates/renames/deletes) via a plain
 * refetch: the list is small and headers are cheap.
 */
import * as api from '$lib/api/artifacts';
import type {
	Artifact,
	ArtifactHeader,
	NavigationDefinition,
	TableDefinition
} from '$lib/api/types';
import { scrubArtifactFromView } from './view.svelte';

let _items = $state<ArtifactHeader[]>([]);
let _loading = $state(false);

export function getArtifactHeaders(): ArtifactHeader[] {
	return _items;
}
export function getArtifactsLoading(): boolean {
	return _loading;
}
export function artifactHeaderById(id: string): ArtifactHeader | undefined {
	return _items.find((a) => a.id === id);
}

export async function loadArtifacts(): Promise<void> {
	_loading = true;
	try {
		_items = (await api.listArtifacts()).items;
	} finally {
		_loading = false;
	}
}

export async function createNavigationArtifact(
	name: string,
	payload: NavigationDefinition
): Promise<Artifact> {
	const created = await api.createArtifact({
		kind: 'navigation',
		name,
		payload: payload as unknown as Record<string, unknown>
	});
	await loadArtifacts();
	return created;
}

export async function createTableArtifact(
	name: string,
	payload: TableDefinition
): Promise<Artifact> {
	const created = await api.createArtifact({
		kind: 'table',
		name,
		payload: payload as unknown as Record<string, unknown>
	});
	await loadArtifacts();
	return created;
}

export async function renameArtifact(id: string, name: string): Promise<void> {
	const header = artifactHeaderById(id);
	if (!header) throw new Error(`Unknown artifact ${id}`);
	const updated = await api.updateArtifact(id, { artifact_rev: header.artifact_rev, name });
	// Refresh just this header from the response (headers-only cache — drop
	// `payload`) rather than a full list refetch: the response already carries
	// the new rev/name, and a redundant listArtifacts() round-trip would race
	// with any concurrent peer edit reflected via the `artifact` feed event.
	_items = _items.map((a) =>
		a.id === id
			? {
					id: updated.id,
					kind: updated.kind,
					name: updated.name,
					artifact_rev: updated.artifact_rev,
					updated_at: updated.updated_at,
					updated_by: updated.updated_by,
					entry_points: updated.entry_points
				}
			: a
	);
}

export async function removeArtifact(id: string): Promise<void> {
	await api.deleteArtifact(id);
	_items = _items.filter((a) => a.id !== id);
	// Scrub this client's own view of any now-dangling placements of the
	// deleted artifact (a no-op when no view is loaded or it never placed this
	// id). Other clients still see the ghost ref until their view refreshes —
	// tolerated and rendered removably by TreeRow (see view-tree.ts); the
	// backend never scrubs on delete because a view owns nothing server-side.
	await scrubArtifactFromView(id);
}

/** Feed reducer hook: an `artifact` event means the library changed somewhere. */
export function handleArtifactFeedEvent(): void {
	void loadArtifacts().catch(() => {});
}

export function resetArtifacts(): void {
	_items = [];
	_loading = false;
}
