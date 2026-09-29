/**
 * Named views. A project holds N views; every client picks its own active one
 * (`lib/state/active-view.svelte.ts`) and edits it through `view.*` ops in
 * `POST /commits`. Add, replace and delete are DIRECT actions (not journaled, not
 * undoable — the metamodel-upload stance), so they live here rather than in
 * the commit flow.
 */
import { z } from 'zod';
import { apiFetch, type ClientConfig } from './client';
import { asSent, route } from './engine-route';
import {
	IssueListSchema,
	ViewStateResponseSchema,
	ViewSummarySchema,
	type Issue,
	type View,
	type ViewStateResponse,
	type ViewSummary
} from './types';

const ViewListSchema = z.array(ViewSummarySchema);

/** GET /views — sorted by name then id, server-side. */
export function listViews(cfg?: ClientConfig): Promise<ViewSummary[]> {
	return apiFetch('/views', { method: 'GET', schema: ViewListSchema }, cfg);
}

/** GET /views/{id} — 404 (NotFoundError) for an unknown or deleted view. */
export function getView(viewId: string, cfg?: ClientConfig): Promise<ViewStateResponse> {
	return apiFetch(
		`/views/${encodeURIComponent(viewId)}`,
		{ method: 'GET', schema: ViewStateResponseSchema },
		cfg
	);
}

/**
 * The warnings of `view`, the active view `viewId` as it is staged. On the
 * engine they are computed over `view`, the working model and the working
 * artifacts; the server's are those of `GET /views/{id}`, over the committed
 * view, model and artifacts. `stale` says `view` may lag the server's
 * document, which ends the shadow's comparison.
 */
export function viewWarnings(
	viewId: string,
	view: View,
	cfg?: ClientConfig,
	stale?: () => boolean
): Promise<Issue[]> {
	return route(
		'views',
		cfg,
		(call) =>
			call<unknown>('validateView', { view: asSent(view) }).then((answer) =>
				IssueListSchema.parse(answer)
			),
		() => getView(viewId, cfg).then((response) => response.warnings),
		{ shadow: 'unstaged', ...(stale === undefined ? {} : { stale }) }
	);
}

/** POST /views — `view` is the raw `*.view.json` document; the server
 * overwrites its own `name` with `name`. 409 (ConflictError) on a duplicate
 * name, 422 (ValidationError) on a blank name or a malformed document. */
export function createView(
	body: { name: string; view: Record<string, unknown> },
	cfg?: ClientConfig
): Promise<ViewSummary> {
	return apiFetch('/views', { method: 'POST', body, schema: ViewSummarySchema }, cfg);
}

/** PUT /views/{id} — replace the whole document (the JSON editor's Save). A
 * `name` differing from the current one renames the view. 409 (ConflictError)
 * on a stale `base_view_rev`, a duplicate name, or a peer lease inside the
 * view; 422 (ValidationError) on a malformed document. */
export function updateView(
	viewId: string,
	body: { view: Record<string, unknown>; base_view_rev?: number | null },
	cfg?: ClientConfig
): Promise<ViewSummary> {
	return apiFetch(
		`/views/${encodeURIComponent(viewId)}`,
		{ method: 'PUT', body, schema: ViewSummarySchema },
		cfg
	);
}

/** DELETE /views/{id} — 409 (ConflictError) while a peer holds a lease on the
 * view or on one of its folders. */
export function deleteView(viewId: string, cfg?: ClientConfig): Promise<void> {
	return apiFetch(`/views/${encodeURIComponent(viewId)}`, { method: 'DELETE' }, cfg);
}
