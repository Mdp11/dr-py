import { apiFetch, apiFetchRaw, type ClientConfig } from './client';
import {
	ChangesDocSchema,
	ChangesSummarySchema,
	ContainmentPageSchema,
	ElementPageSchema,
	ModelSummarySchema,
	NeighborhoodSchema,
	RelationshipPageSchema,
	type ChangesDoc,
	type ChangesSummary,
	type ContainmentPage,
	type ElementPage,
	type ModelSummary,
	type Neighborhood,
	type RelationshipPage
} from './types';

/**
 * Paged/on-demand read side of the delta protocol (Phase D1). All endpoints
 * are strictly read-only; the backend caps `limit` at 500.
 */

/** GET /model/summary — cheap whole-model statistics. */
export function getModelSummary(cfg?: ClientConfig): Promise<ModelSummary> {
	return apiFetch('/model/summary', { method: 'GET', schema: ModelSummarySchema }, cfg);
}

export interface ElementsPageQuery {
	/** exact type-name filter (no inheritance roll-up) */
	type?: string;
	/** search query; ranked by the Search.svelte score when present */
	q?: string;
	limit?: number;
	offset?: number;
}

/** GET /model/elements — paged listing with optional type filter + search. */
export function listElementsPage(
	query?: ElementsPageQuery,
	cfg?: ClientConfig
): Promise<ElementPage> {
	return apiFetch(
		'/model/elements',
		{
			method: 'GET',
			schema: ElementPageSchema,
			query: {
				type: query?.type,
				q: query?.q,
				limit: query?.limit,
				offset: query?.offset
			}
		},
		cfg
	);
}

/**
 * GET /model/elements/{id}/neighborhood — BFS graph extraction around one
 * element (`hops` 1-5, `cap` is a hard node-count cap; `truncated` reports
 * dropped neighbors).
 */
export function getNeighborhood(
	elementId: string,
	opts?: { hops?: number; cap?: number },
	cfg?: ClientConfig
): Promise<Neighborhood> {
	return apiFetch(
		`/model/elements/${encodeURIComponent(elementId)}/neighborhood`,
		{
			method: 'GET',
			schema: NeighborhoodSchema,
			query: { hops: opts?.hops, cap: opts?.cap }
		},
		cfg
	);
}

/** GET /model/elements/{id}/relationships — incident relationships, paged. */
export function listElementRelationships(
	elementId: string,
	opts?: { direction?: 'both' | 'in' | 'out'; limit?: number; offset?: number },
	cfg?: ClientConfig
): Promise<RelationshipPage> {
	return apiFetch(
		`/model/elements/${encodeURIComponent(elementId)}/relationships`,
		{
			method: 'GET',
			schema: RelationshipPageSchema,
			query: { direction: opts?.direction, limit: opts?.limit, offset: opts?.offset }
		},
		cfg
	);
}

/** GET /model/containment/roots — elements with no containment parent. */
export function listContainmentRoots(
	opts?: { limit?: number; offset?: number },
	cfg?: ClientConfig
): Promise<ContainmentPage> {
	return apiFetch(
		'/model/containment/roots',
		{
			method: 'GET',
			schema: ContainmentPageSchema,
			query: { limit: opts?.limit, offset: opts?.offset }
		},
		cfg
	);
}

/** GET /model/elements/{id}/children — containment children, paged. */
export function listContainmentChildren(
	elementId: string,
	opts?: { limit?: number; offset?: number },
	cfg?: ClientConfig
): Promise<ContainmentPage> {
	return apiFetch(
		`/model/elements/${encodeURIComponent(elementId)}/children`,
		{
			method: 'GET',
			schema: ContainmentPageSchema,
			query: { limit: opts?.limit, offset: opts?.offset }
		},
		cfg
	);
}

/**
 * GET /model/changes — the pending change set as a `datarover.cr/v1`
 * document (+ `complete`).
 */
export function getChanges(cfg?: ClientConfig): Promise<ChangesDoc> {
	return apiFetch('/model/changes', { method: 'GET', schema: ChangesDocSchema }, cfg);
}

/** GET /model/changes/summary — counts over the compacted change set. */
export function getChangesSummary(cfg?: ClientConfig): Promise<ChangesSummary> {
	return apiFetch('/model/changes/summary', { method: 'GET', schema: ChangesSummarySchema }, cfg);
}

/**
 * GET /model/download — the session model as a streaming attachment.
 * Returns the raw `Response` so the caller can pipe `response.body` (e.g.
 * into a FileSystem writable) without materializing the JSON as a string.
 * Non-2xx still raises the usual typed `ApiError`s.
 */
export function downloadModel(cfg?: ClientConfig): Promise<Response> {
	return apiFetchRaw('/model/download', { method: 'GET' }, cfg);
}
