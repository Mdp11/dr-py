import { describe, it, expect } from 'vitest';
import { acquireLocks, previewCommit, commitChanges, openProject } from '../checkout';
import { getCurrentUserId } from '../client';

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

describe('checkout api', () => {
	it('POSTs /locks with targets+intent', async () => {
		const cap: { path?: string; body?: unknown } = {};
		const res = await acquireLocks(
			{ targets: [{ resource_id: 'e1', mode: 'exclusive' }], intent: 'edit', steal: false },
			{ fetch: jsonFetch(cap, { token: 't1', leases: [] }) }
		);
		expect(cap.path).toContain('/locks');
		expect((cap.body as { intent: string }).intent).toBe('edit');
		expect(res.token).toBe('t1');
	});

	it('previewCommit sends base_rev + ops', async () => {
		const cap: { path?: string; body?: unknown } = {};
		await previewCommit(7, [], {
			fetch: jsonFetch(cap, { conformance_error_count: 0, structural_blockers: [], issues: [] })
		});
		expect(cap.path).toContain('/commits/preview');
		expect((cap.body as { base_rev: number }).base_rev).toBe(7);
	});

	it('commitChanges maps camelCase to snake_case body', async () => {
		const cap: { path?: string; body?: unknown } = {};
		await commitChanges(
			{ baseRev: 7, ops: [], message: 'm', lockTokens: ['t1'], ackErrors: true },
			{
				fetch: jsonFetch(cap, {
					model_rev: 8,
					id_map: {},
					changed_elements: [],
					changed_relationships: [],
					deleted_element_ids: [],
					deleted_relationship_ids: [],
					issues_removed_owner_ids: [],
					issues_added: [],
					issue_counts: {},
					commit_id: 'c1',
					message: 'm',
					validation_error_count: 0
				})
			}
		);
		const body = cap.body as Record<string, unknown>;
		expect(body.base_rev).toBe(7);
		expect(body.lock_tokens).toEqual(['t1']);
		expect(body.ack_errors).toBe(true);
	});

	it('openProject GETs /open', async () => {
		const cap: { path?: string; body?: unknown } = {};
		const res = await openProject({
			fetch: jsonFetch(cap, {
				model_rev: 1,
				role: 'editor',
				element_count: 0,
				relationship_count: 0,
				issue_counts: {},
				lock_ttl_seconds: 300
			})
		});
		expect(cap.path).toContain('/open');
		expect(res.role).toBe('editor');
	});

	it('getCurrentUserId returns empty string until auth store sets it', () => {
		expect(getCurrentUserId()).toBe('');
	});
});
