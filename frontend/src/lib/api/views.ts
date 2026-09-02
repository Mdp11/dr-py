/**
 * Named views. A project holds N views; every client picks its own active one
 * (`lib/state/active-view.svelte.ts`) and edits it through `view.*` ops in
 * `POST /commits`. Add and delete are DIRECT actions (not journaled, not
 * undoable — the metamodel-upload stance), so they live here rather than in
 * the commit flow.
 */
import { z } from 'zod';
import { apiFetch, type ClientConfig } from './client';
import {
	ViewStateResponseSchema,
	ViewSummarySchema,
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

/** POST /views — `view` is the raw `*.view.json` document; the server
 * overwrites its own `name` with `name`. 409 (ConflictError) on a duplicate
 * name, 422 (ValidationError) on a blank name or a malformed document. */
export function createView(
	body: { name: string; view: Record<string, unknown> },
	cfg?: ClientConfig
): Promise<ViewSummary> {
	return apiFetch('/views', { method: 'POST', body, schema: ViewSummarySchema }, cfg);
}

/** DELETE /views/{id} — 409 (ConflictError) while a peer holds a lease on the
 * view or on one of its folders. */
export function deleteView(viewId: string, cfg?: ClientConfig): Promise<void> {
	return apiFetch(`/views/${encodeURIComponent(viewId)}`, { method: 'DELETE' }, cfg);
}
