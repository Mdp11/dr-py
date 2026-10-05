import { asSent, route } from './engine-route';
import {
	ElementListSchema,
	ElementPageSchema,
	EngineModelFileSchema,
	ModelSummarySchema,
	RelationshipPageSchema,
	SearchResultPageSchema,
	TreeItemPageSchema,
	type Element,
	type ElementPage,
	type ModelSummary,
	type RelationshipPage,
	type SearchResultPage,
	type TreeItem,
	type TreeItemPage
} from './types';
import type { AdvancedQuery } from '$lib/search/types';

/**
 * Paged/on-demand reads of the model, answered by the engine replica
 * (`route`); the answers pass the same schemas as the server's did. A page's
 * `limit` is capped at 500.
 */

/** A route's options for a read that may carry a `signal`. */
const signalOf = (signal: AbortSignal | undefined) => (signal === undefined ? {} : { signal });

/** `params` without its `undefined` values: an option the caller omitted is not sent. */
function present(params: { [key: string]: unknown }): { [key: string]: unknown } {
	return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined));
}

/** Cheap whole-model statistics; the engine's carry no issue counts. */
export function getModelSummary(): Promise<ModelSummary> {
	return route<unknown>('getModelSummary', {}).then((body) => ModelSummarySchema.parse(body));
}

/**
 * Fetch many elements by id in one call. Ids come back in request order;
 * unknown/deleted ids are omitted. Caller must keep `ids.length <= READ_PAGE_LIMIT`.
 */
export function getElementsBatch(ids: string[]): Promise<Element[]> {
	return route<unknown>('getElementsBatch', { ids }).then(
		(body) => ElementListSchema.parse(body).items
	);
}

/**
 * Lite by-id projection for tree rows (id, type_name, display_name,
 * child_count). Ids come back in request order; unknown/deleted ids are
 * omitted. Caller must keep `ids.length <= READ_PAGE_LIMIT`.
 */
export function getTreeItemsBatch(ids: string[]): Promise<TreeItem[]> {
	return route<unknown>('getTreeItemsBatch', { ids }).then(
		(body) => TreeItemPageSchema.parse(body).items
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

/** Paged element listing with optional type filter + search. */
export function listElementsPage(query?: ElementsPageQuery): Promise<ElementPage> {
	const params = { type: query?.type, q: query?.q, limit: query?.limit, offset: query?.offset };
	return route<unknown>('listElementsPage', present(params), signalOf(query?.signal)).then((body) =>
		ElementPageSchema.parse(body)
	);
}

/**
 * Advanced search over the WHOLE model (not the client's fetched subset).
 * Returns a hydrated, paged result set; `total` is the full match count
 * before limit/offset paging.
 */
export function searchModel(
	query: AdvancedQuery,
	opts?: { limit?: number; offset?: number }
): Promise<SearchResultPage> {
	const page = { limit: opts?.limit, offset: opts?.offset };
	return route<unknown>(
		'searchModel',
		asSent({ target: query.target, criteria: query.criteria, ...page })
	).then((body) => SearchResultPageSchema.parse(body));
}

/** Incident relationships of one element, paged. */
export function listElementRelationships(
	elementId: string,
	opts?: {
		direction?: 'both' | 'in' | 'out';
		limit?: number;
		offset?: number;
		signal?: AbortSignal;
	}
): Promise<RelationshipPage> {
	const query = { direction: opts?.direction, limit: opts?.limit, offset: opts?.offset };
	return route<unknown>(
		'listElementRelationships',
		present({ id: elementId, ...query }),
		signalOf(opts?.signal)
	).then((body) => RelationshipPageSchema.parse(body));
}

/** Elements with no containment parent. */
export function listContainmentRoots(opts?: {
	limit?: number;
	offset?: number;
	signal?: AbortSignal;
}): Promise<TreeItemPage> {
	const query = { limit: opts?.limit, offset: opts?.offset };
	return route<unknown>('listContainmentRoots', present(query), signalOf(opts?.signal)).then(
		(body) => TreeItemPageSchema.parse(body)
	);
}

/** Backend cap on the `limit` of every paged read. Requests above it are
 * REJECTED (422), not clamped. */
export const READ_PAGE_LIMIT = 500;

/**
 * Fetch `limit` containment roots starting at `offset` (default 0), issuing as
 * many sequential `READ_PAGE_LIMIT`-sized page requests as needed (a request
 * above the cap is rejected with a 422 rather than clamped, so a total beyond
 * 500 MUST be assembled by offset paging). Stops early when the roots run
 * out. `total` is the total from the last page.
 *
 * `offset` exists so scroll auto-load growth can APPEND: growing an already
 * loaded prefix by one page fetches just the missing tail instead of
 * re-reading offsets 0..N — on a large model that refetch-from-zero
 * pattern made growth O(n²) in requests.
 */
export async function listContainmentRootsPaged(limit: number, offset = 0): Promise<TreeItemPage> {
	const items: TreeItemPage['items'] = [];
	let total = 0;
	while (items.length < limit) {
		const page = await listContainmentRoots({
			limit: Math.min(READ_PAGE_LIMIT, limit - items.length),
			offset: offset + items.length
		});
		items.push(...page.items);
		total = page.total;
		// stop on the last page (also guards against a zero-progress loop)
		if (offset + items.length >= total || page.items.length === 0) break;
	}
	return { items, total };
}

/** Roots not placed in view `viewId` (every root when omitted: no view
 * places anything). */
export function listExcludedRoots(opts?: {
	limit?: number;
	offset?: number;
	viewId?: string;
	signal?: AbortSignal;
}): Promise<TreeItemPage> {
	const query = { limit: opts?.limit, offset: opts?.offset, view_id: opts?.viewId };
	return route<unknown>('listExcludedRoots', present(query), signalOf(opts?.signal)).then((body) =>
		TreeItemPageSchema.parse(body)
	);
}

/** Offset-paged assembly of `limit` excluded roots starting at `offset`
 * (mirrors {@link listContainmentRootsPaged}, including the append-only-growth
 * rationale for `offset`; a page is capped at READ_PAGE_LIMIT). */
export async function listExcludedRootsPaged(
	limit: number,
	offset = 0,
	viewId?: string
): Promise<TreeItemPage> {
	const items: TreeItemPage['items'] = [];
	let total = 0;
	while (items.length < limit) {
		const page = await listExcludedRoots({
			limit: Math.min(READ_PAGE_LIMIT, limit - items.length),
			offset: offset + items.length,
			viewId
		});
		items.push(...page.items);
		total = page.total;
		if (offset + items.length >= total || page.items.length === 0) break;
	}
	return { items, total };
}

/** Containment children of one element, paged. */
export function listContainmentChildren(
	elementId: string,
	opts?: { limit?: number; offset?: number; signal?: AbortSignal }
): Promise<TreeItemPage> {
	const query = { limit: opts?.limit, offset: opts?.offset };
	return route<unknown>(
		'listContainmentChildren',
		present({ id: elementId, ...query }),
		signalOf(opts?.signal)
	).then((body) => TreeItemPageSchema.parse(body));
}

/**
 * The committed model's file as a Blob, never parsed: the engine writes it
 * from its replica, whatever is staged there, byte for byte the server's.
 */
export function downloadModel(): Promise<Blob> {
	return route<unknown>('downloadModel', {}).then((answer) => {
		const file = EngineModelFileSchema.parse(answer);
		return new Blob(file.parts, { type: file.content_type });
	});
}
