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

/** Fetch the xlsx as a Blob (raw Response → blob); caller triggers the download. */
export async function exportTable(
	args: { definition?: TableDefinition; artifactId?: string; sort?: TableSort },
	cfg?: ClientConfig
): Promise<{ blob: Blob; filename: string }> {
	const res = await apiFetchRaw(
		'/tables/export',
		{
			method: 'POST',
			body: { definition: args.definition, artifact_id: args.artifactId, sort: args.sort }
		},
		cfg
	);
	const disp = res.headers.get('content-disposition') ?? '';
	const m = /filename="([^"]+)"/.exec(disp);
	return { blob: await res.blob(), filename: m?.[1] ?? 'table.xlsx' };
}
