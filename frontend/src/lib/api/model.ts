import { apiFetch, type ClientConfig } from './client';
import { ModelOutSchema, type ModelOut } from './types';

/**
 * Fetch the ENTIRE session model in one response. Deliberately whole-model:
 * only the compare page uses it (comparing the session against a picked file
 * is inherently a whole-model operation). Everything else reads via the
 * paged endpoints in `./model-read.ts`.
 */
export function getModel(cfg?: ClientConfig): Promise<ModelOut> {
	return apiFetch('/model', { method: 'GET', schema: ModelOutSchema }, cfg);
}
