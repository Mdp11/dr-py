import { apiFetch, type ClientConfig } from './client';
import {
	IssueListSchema,
	type InlineModel,
	type Issue
} from './types';

export interface ValidateOptions {
	inline?: InlineModel;
	scope?: string[];
}

export function validateModel(
	modelName: string,
	options?: ValidateOptions,
	cfg?: ClientConfig
): Promise<Issue[]> {
	const body =
		options && (options.inline !== undefined || options.scope !== undefined)
			? { inline: options.inline, scope: options.scope }
			: undefined;
	return apiFetch(
		`/models/${encodeURIComponent(modelName)}/validate`,
		{ method: 'POST', body, schema: IssueListSchema },
		cfg
	);
}
