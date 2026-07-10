import { z } from 'zod';
import { apiFetch, type ClientConfig } from './client';

/**
 * GET /model/status (Task 6) — cheap poll target for the open-progress
 * overlay (Task 9's `trackOpenProgress`). Never triggers hydration itself;
 * `hydration`/`validation` are only present while the corresponding phase is
 * in flight.
 */
export const ModelStatusSchema = z.object({
	state: z.enum(['cold', 'hydrating', 'empty', 'validating', 'ready']),
	model_rev: z.number().nullable().optional(),
	validation: z
		.object({ running: z.boolean(), done: z.number(), total: z.number() })
		.nullable()
		.optional(),
	hydration: z
		.object({ phase: z.string(), done: z.number(), total: z.number() })
		.nullable()
		.optional()
});

export type ModelStatus = z.infer<typeof ModelStatusSchema>;

export function getModelStatus(cfg?: ClientConfig): Promise<ModelStatus> {
	return apiFetch('/model/status', { method: 'GET', schema: ModelStatusSchema }, cfg);
}
