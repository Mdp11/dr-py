import { apiFetch, apiFetchRaw, type ClientConfig } from './client';
import {
	TablePageSchema,
	type ScriptErrorsRecap,
	type TableDefinition,
	type TablePage,
	type TableSort
} from './types';

interface EvaluateArgs {
	definition?: TableDefinition;
	artifactId?: string;
	offset?: number;
	limit?: number;
	sort?: TableSort;
}

export function evaluateTable(args: EvaluateArgs, cfg?: ClientConfig): Promise<TablePage> {
	const body = {
		definition: args.definition,
		artifact_id: args.artifactId,
		offset: args.offset ?? 0,
		limit: args.limit ?? 100,
		sort: args.sort
	};
	return apiFetch('/tables/evaluate', { method: 'POST', body, schema: TablePageSchema }, cfg);
}

/**
 * Outcome of a `/tables/export` call. `'preparing'` means the backend's
 * cache-only export path hasn't finished computing every script cell yet — it
 * answered 202 with `Retry-After: 1` instead of the xlsx body. The caller is
 * expected to retry after a short delay (the retry loop itself is Task 10);
 * this task only distinguishes the two outcomes.
 */
export type ExportResult =
	| { kind: 'ready'; blob: Blob; filename: string }
	| { kind: 'preparing'; done: number; total: number | null };

/** Export the current definition (or saved artifact) as an .xlsx. Resolves to
 * `{ kind: 'ready' }` with the Blob once the backend has it, or
 * `{ kind: 'preparing' }` while the script-cache sweep is still filling in
 * cells for this table (backend 202 + Retry-After). */
export async function exportTable(
	args: { definition?: TableDefinition; artifactId?: string; sort?: TableSort },
	cfg?: ClientConfig
): Promise<ExportResult> {
	const res = await apiFetchRaw(
		'/tables/export',
		{
			method: 'POST',
			body: { definition: args.definition, artifact_id: args.artifactId, sort: args.sort }
		},
		cfg
	);
	if (res.status === 202) {
		const body = (await res.json()) as { done?: number; total?: number | null };
		return { kind: 'preparing', done: body.done ?? 0, total: body.total ?? null };
	}
	const disp = res.headers.get('content-disposition') ?? '';
	const m = /filename="([^"]+)"/.exec(disp);
	return { kind: 'ready', blob: await res.blob(), filename: m?.[1] ?? 'table.xlsx' };
}

/**
 * Every failing script cell in the WHOLE table, with the grid position to jump
 * to (`POST /tables/script-errors`). The grid is virtualized, so the client
 * only ever holds a window of rows — this route is the only complete answer.
 *
 * `sort` is load-bearing and `offset`/`limit` are not: the recap is always
 * whole-table (the route ignores the window fields), but `row_index` is only a
 * valid grid address for the `(definition, sort, model_rev)` the page was
 * rendered with, so the caller must forward the sort the grid is showing.
 *
 * THE STATUS CODE IS THE RETRY SIGNAL, exactly as for `exportTable`: while the
 * background sweep is still filling this table's script cells the route answers
 * **202 + Retry-After: 1** with a status body, which resolves here to
 * `{ retry: true }`. The body's own `state` is a convenience and must not be
 * switched on — a 202 body routinely says `computing` for a sweep that already
 * finished (the server decides ship-vs-retry by re-probing its cache).
 */
export async function fetchScriptErrors(
	args: Omit<EvaluateArgs, 'offset' | 'limit'>,
	cfg?: ClientConfig
): Promise<ScriptErrorsRecap | { retry: true }> {
	const res = await apiFetchRaw(
		'/tables/script-errors',
		{
			method: 'POST',
			body: { definition: args.definition, artifact_id: args.artifactId, sort: args.sort }
		},
		cfg
	);
	if (res.status === 202) return { retry: true };
	return (await res.json()) as ScriptErrorsRecap;
}
