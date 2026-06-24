import { describe, it, expect } from 'vitest';
import { getCommitHistory, getModelAtRev, revertToCommit } from '../history';

function jsonFetch(captured: { path?: string; body?: unknown }, payload: unknown) {
	return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		captured.path = String(input);
		captured.body = init?.body ? JSON.parse(init.body as string) : undefined;
		return new Response(JSON.stringify(payload), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		});
	};
}

describe('history api', () => {
	it('getCommitHistory passes limit + before_rev as query', async () => {
		const cap: { path?: string; body?: unknown } = {};
		const res = await getCommitHistory(
			{ limit: 2, beforeRev: 5 },
			{ fetch: jsonFetch(cap, { commits: [], has_more: false }) }
		);
		expect(cap.path).toContain('/commits');
		expect(cap.path).toContain('limit=2');
		expect(cap.path).toContain('before_rev=5');
		expect(res.has_more).toBe(false);
	});

	it('getModelAtRev hits /commits/{rev}/model', async () => {
		const cap: { path?: string; body?: unknown } = {};
		const res = await getModelAtRev(3, {
			fetch: jsonFetch(cap, { elements: [], relationships: [] })
		});
		expect(cap.path).toContain('/commits/3/model');
		expect(res.elements).toEqual([]);
	});

	it('revertToCommit maps camelCase to snake_case body', async () => {
		const cap: { path?: string; body?: unknown } = {};
		await revertToCommit(
			{ targetRev: 2, baseRev: 7, message: 'undo' },
			{
				fetch: jsonFetch(cap, {
					model_rev: 8, id_map: {}, changed_elements: [], changed_relationships: [],
					deleted_element_ids: [], deleted_relationship_ids: [],
					issues_removed_owner_ids: [], issues_added: [], issue_counts: {},
					commit_id: 'c', message: 'undo', validation_error_count: 0
				})
			}
		);
		expect(cap.path).toContain('/commits/revert');
		expect(cap.body).toMatchObject({ target_rev: 2, base_rev: 7, message: 'undo' });
	});
});
