import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';

import { server } from '$lib/api/__tests__/server';
import { emit } from '../model.svelte';
import { validateAll, resetModelStore, adoptSummary, setModelApiConfig } from '../model.svelte';

const BASE = 'http://api.test/api/v1';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
	server.resetHandlers();
	resetModelStore();
});
afterAll(() => server.close());

describe('validateAll with staged ops', () => {
	it('sends staged ops + base_rev to /model/validate', async () => {
		setModelApiConfig({ baseUrl: BASE });
		adoptSummary({
			model_rev: 4,
			element_count: 0,
			relationship_count: 0,
			elements_by_type: {},
			issue_counts: {},
			undo_depth: 0
		});
		emit({ kind: 'create_element', temp_id: 'tmp1', type_name: 'Block', properties: {} });

		let body: { ops?: unknown[]; base_rev?: number } | undefined;
		server.use(
			http.post(`${BASE}/model/validate`, async ({ request }) => {
				body = (await request.json()) as typeof body;
				return HttpResponse.json([
					{ severity: 'error', message: 'e', target_ids: ['tmp1'], origin: 'uncommitted' }
				]);
			})
		);

		const issues = await validateAll();
		expect(body?.base_rev).toBe(4);
		expect(body?.ops).toHaveLength(1);
		expect(issues[0].origin).toBe('uncommitted');
	});
});
