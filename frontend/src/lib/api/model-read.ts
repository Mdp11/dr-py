import { apiFetch, apiFetchRaw, type ClientConfig } from './client';
import { route, type Surface } from './engine-route';
import {
	ChangesDocSchema,
	ChangesSummarySchema,
	ElementListSchema,
	ElementPageSchema,
	ModelSummarySchema,
	NeighborhoodSchema,
	RelationshipPageSchema,
	SearchResultPageSchema,
	TreeItemPageSchema,
	type ChangesDoc,
	type ChangesSummary,
	type Element,
	type ElementList,
	type ElementPage,
	type ModelSummary,
	type Neighborhood,
	type RelationshipPage,
	type SearchResultPage,
	type TreeItem,
	type TreeItemPage
} from './types';
import type { AdvancedQuery } from '$lib/search/types';

/**
 * Paged/on-demand read side of the delta protocol (Phase D1). All endpoints
 * are strictly read-only; the backend caps `limit` at 500. The nine model
 * reads are answered by the engine replica or the server, per surface
 * (`route`); both sides' bodies pass the same schema.
 */

/** `params` without its `undefined` values: an option the caller omitted is not sent. */
function present(params: { [key: string]: unknown }): { [key: string]: unknown } {
	return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
}

/** A server read's `init.signal`, when it has one. */
const signalOf = (signal: AbortSignal | undefined) => (signal === undefined ? {} : { signal });

/** GET /model/summary — cheap whole-model statistics. */
export function getModelSummary(cfg?: ClientConfig): Promise<ModelSummary> {
	return route(
		'summary',
		cfg,
		(call) => call('getModelSummary', {}).then((body) => ModelSummarySchema.parse(body)),
		() => apiFetch('/model/summary', { method: 'GET', schema: ModelSummarySchema }, cfg)
	);
}

/**
 * POST /model/elements/batch — fetch many elements by id in one request.
 * Ids come back in request order; unknown/deleted ids are omitted by the
 * server. Caller must keep `ids.length <= READ_PAGE_LIMIT`.
 */
export function getElementsBatch(ids: string[], cfg?: ClientConfig): Promise<Element[]> {
	return route(
		'elements',
		cfg,
		(call) => call('getElementsBatch', { ids }).then((body) => ElementListSchema.parse(body).items),
		() =>
			apiFetch<ElementList>(
				'/model/elements/batch',
				{ method: 'POST', body: { ids }, schema: ElementListSchema },
				cfg
			).then((r) => r.items)
	);
}

/**
 * POST /model/elements/tree-items — lite by-id projection for tree rows
 * (id, type_name, display_name, child_count). Ids come back in request order;
 * unknown/deleted ids are omitted. Caller must keep `ids.length <= READ_PAGE_LIMIT`.
 */
export function getTreeItemsBatch(ids: string[], cfg?: ClientConfig): Promise<TreeItem[]> {
	return route(
		'tree',
		cfg,
		(call) =>
			call('getTreeItemsBatch', { ids }).then((body) => TreeItemPageSchema.parse(body).items),
		() =>
			apiFetch<TreeItemPage>(
				'/model/elements/tree-items',
				{ method: 'POST', body: { ids }, schema: TreeItemPageSchema },
				cfg
			).then((r) => r.items)
	);
}

export interface ElementsPageQuery {
	/** exact type-name filter (no inheritance roll-up) */
	type?: string;
	/** search query; ranked by the Search.svelte score when present */
	q?: string;
	limit?: number;
	offset?: number;
	signal?: AbortSignal;
}

/** GET /model/elements — paged listing with optional type filter + search.
 * A query that is not blank is the `search` surface, anything else `elements`. */
export function listElementsPage(
	query?: ElementsPageQuery,
	cfg?: ClientConfig
): Promise<ElementPage> {
	const surface: Surface = query?.q?.trim() ? 'search' : 'elements';
	const params = { type: query?.type, q: query?.q, limit: query?.limit, offset: query?.offset };
	return route(
		surface,
		cfg,
		(call) =>
			call('listElementsPage', present(params), query?.signal).then((body) =>
				ElementPageSchema.parse(body)
			),
		() =>
			apiFetch(
				'/model/elements',
				{ method: 'GET', schema: ElementPageSchema, query: params, ...signalOf(query?.signal) },
				cfg
			)
	);
}

/**
 * POST /model/search — server-side advanced search over the WHOLE model
 * (not the client's fetched subset). Returns a hydrated, paged result set;
 * `total` is the full match count before limit/offset paging.
 */
export function searchModel(
	query: AdvancedQuery,
	opts?: { limit?: number; offset?: number },
	cfg?: ClientConfig
): Promise<SearchResultPage> {
	return apiFetch(
		'/model/search',
		{
			method: 'POST',
			body: { ...query, limit: opts?.limit, offset: opts?.offset },
			schema: SearchResultPageSchema
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
	opts?: {
		direction?: 'both' | 'in' | 'out';
		limit?: number;
		offset?: number;
		signal?: AbortSignal;
	},
	cfg?: ClientConfig
): Promise<RelationshipPage> {
	const query = { direction: opts?.direction, limit: opts?.limit, offset: opts?.offset };
	return route(
		'relationships',
		cfg,
		(call) =>
			call('listElementRelationships', present({ id: elementId, ...query }), opts?.signal).then(
				(body) => RelationshipPageSchema.parse(body)
			),
		() =>
			apiFetch(
				`/model/elements/${encodeURIComponent(elementId)}/relationships`,
				{ method: 'GET', schema: RelationshipPageSchema, query, ...signalOf(opts?.signal) },
				cfg
			)
	);
}

/** GET /model/containment/roots — elements with no containment parent. */
export function listContainmentRoots(
	opts?: { limit?: number; offset?: number; signal?: AbortSignal },
	cfg?: ClientConfig
): Promise<TreeItemPage> {
	const query = { limit: opts?.limit, offset: opts?.offset };
	return route(
		'tree',
		cfg,
		(call) =>
			call('listContainmentRoots', present(query), opts?.signal).then((body) =>
				TreeItemPageSchema.parse(body)
			),
		() =>
			apiFetch(
				'/model/containment/roots',
				{ method: 'GET', schema: TreeItemPageSchema, query, ...signalOf(opts?.signal) },
				cfg
			)
	);
}

/** Backend cap on the `limit` query param of every paged read endpoint.
 * Requests above it are REJECTED (422), not clamped. */
export const READ_PAGE_LIMIT = 500;

/**
 * Fetch `limit` containment roots starting at `offset` (default 0), issuing as
 * many sequential `READ_PAGE_LIMIT`-sized page requests as needed (the backend
 * rejects `limit > 500` with a 422 rather than clamping, so a total beyond 500
 * MUST be assembled by offset paging). Stops early when the server runs out of
 * roots. `total` is the server total from the last page.
 *
 * `offset` exists so scroll auto-load growth can APPEND: growing an already
 * loaded prefix by one page fetches just the missing tail instead of
 * re-downloading offsets 0..N — on a large model that refetch-from-zero
 * pattern made growth O(n²) in requests.
 */
export async function listContainmentRootsPaged(
	limit: number,
	cfg?: ClientConfig,
	offset = 0
): Promise<TreeItemPage> {
	const items: TreeItemPage['items'] = [];
	let total = 0;
	while (items.length < limit) {
		const page = await listContainmentRoots(
			{ limit: Math.min(READ_PAGE_LIMIT, limit - items.length), offset: offset + items.length },
			cfg
		);
		items.push(...page.items);
		total = page.total;
		// stop on the last page (also guards against a zero-progress loop)
		if (offset + items.length >= total || page.items.length === 0) break;
	}
	return { items, total };
}

/** GET /model/containment/roots/excluded — roots not placed in view
 * `viewId` (every root when omitted: no view places anything). */
export function listExcludedRoots(
	opts?: { limit?: number; offset?: number; viewId?: string; signal?: AbortSignal },
	cfg?: ClientConfig
): Promise<TreeItemPage> {
	const query = { limit: opts?.limit, offset: opts?.offset, view_id: opts?.viewId };
	return route(
		'tree',
		cfg,
		(call) =>
			call('listExcludedRoots', present(query), opts?.signal).then((body) =>
				TreeItemPageSchema.parse(body)
			),
		() =>
			apiFetch(
				'/model/containment/roots/excluded',
				{ method: 'GET', schema: TreeItemPageSchema, query, ...signalOf(opts?.signal) },
				cfg
			)
	);
}

/** Offset-paged assembly of `limit` excluded roots starting at `offset`
 * (mirrors {@link listContainmentRootsPaged}, including the append-only-growth
 * rationale for `offset`; backend caps a page at READ_PAGE_LIMIT). */
export async function listExcludedRootsPaged(
	limit: number,
	cfg?: ClientConfig,
	offset = 0,
	viewId?: string
): Promise<TreeItemPage> {
	const items: TreeItemPage['items'] = [];
	let total = 0;
	while (items.length < limit) {
		const page = await listExcludedRoots(
			{
				limit: Math.min(READ_PAGE_LIMIT, limit - items.length),
				offset: offset + items.length,
				viewId
			},
			cfg
		);
		items.push(...page.items);
		total = page.total;
		if (offset + items.length >= total || page.items.length === 0) break;
	}
	return { items, total };
}

/** GET /model/elements/{id}/children — containment children, paged. */
export function listContainmentChildren(
	elementId: string,
	opts?: { limit?: number; offset?: number; signal?: AbortSignal },
	cfg?: ClientConfig
): Promise<TreeItemPage> {
	const query = { limit: opts?.limit, offset: opts?.offset };
	return route(
		'tree',
		cfg,
		(call) =>
			call('listContainmentChildren', present({ id: elementId, ...query }), opts?.signal).then(
				(body) => TreeItemPageSchema.parse(body)
			),
		() =>
			apiFetch(
				`/model/elements/${encodeURIComponent(elementId)}/children`,
				{ method: 'GET', schema: TreeItemPageSchema, query, ...signalOf(opts?.signal) },
				cfg
			)
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
