import { apiFetch, type ClientConfig } from './client';
import {
	ArtifactListSchema,
	ArtifactSchema,
	ChainPageSchema,
	type Artifact,
	type ArtifactList,
	type ChainPage,
	type NavigationDefinition
} from './types';

export function listArtifacts(kind?: string, cfg?: ClientConfig): Promise<ArtifactList> {
	return apiFetch(
		'/artifacts',
		{ method: 'GET', schema: ArtifactListSchema, query: { kind } },
		cfg
	);
}

export function getArtifact(id: string, cfg?: ClientConfig): Promise<Artifact> {
	return apiFetch(`/artifacts/${id}`, { method: 'GET', schema: ArtifactSchema }, cfg);
}

/*
 * There are deliberately NO artifact write wrappers here. Artifact creation,
 * update and deletion travel as staged `create_artifact`/`update_artifact`/
 * `delete_artifact` ops through `POST /commits` (see `lib/state/artifact-edits`
 * and `lib/api/checkout`), which is the only lock-VERIFIED artifact writer. The
 * backend's legacy `POST/PUT/DELETE /artifacts` routes still exist and still
 * honor `art:` leases, but the client must never reach for them: an unlocked
 * write would land outside the commit journal, so nothing would show up in the
 * DiffDrawer, no `Commit` row would carry it, and undo could not replay it.
 */

export function evaluateNavigation(
	body: {
		definition?: NavigationDefinition;
		artifact_id?: string;
		limit?: number;
		offset?: number;
		/** Binds any RowStart in `definition` (embedded column previews). */
		row_element_id?: string | null;
	},
	cfg?: ClientConfig
): Promise<ChainPage> {
	return apiFetch('/navigations/evaluate', { method: 'POST', body, schema: ChainPageSchema }, cfg);
}
