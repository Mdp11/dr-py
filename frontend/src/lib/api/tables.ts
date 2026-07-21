import { apiFetch, apiFetchRaw, type ClientConfig } from './client';
import { TablePageSchema, type TableDefinition, type TablePage, type TableSort } from './types';

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
