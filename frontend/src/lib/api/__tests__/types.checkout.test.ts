import { describe, it, expect } from 'vitest';
import {
	LockResponseSchema,
	OpenResponseSchema,
	PreviewResponseSchema,
	CommitResponseSchema
} from '../types';

describe('checkout schemas', () => {
	it('parses a LockResponse', () => {
		const v = LockResponseSchema.parse({
			token: 't1',
			leases: [
				{
					resource_id: 'e1',
					mode: 'exclusive',
					holder: 'u',
					token: 't1',
					intent: 'edit',
					expires_at: 1.5
				}
			]
		});
		expect(v.leases[0].resource_id).toBe('e1');
	});

	it('parses an OpenResponse with lock_ttl_seconds', () => {
		const v = OpenResponseSchema.parse({
			model_rev: 3,
			role: 'editor',
			element_count: 1,
			relationship_count: 0,
			issue_counts: {},
			lock_ttl_seconds: 300
		});
		expect(v.lock_ttl_seconds).toBe(300);
		expect(v.role).toBe('editor');
	});

	it('parses a PreviewResponse', () => {
		const v = PreviewResponseSchema.parse({
			conformance_error_count: 2,
			structural_blockers: [],
			issues: [{ severity: 'error', message: 'x', target_ids: ['e1'], category: 'conformance' }]
		});
		expect(v.conformance_error_count).toBe(2);
		expect(v.issues[0].category).toBe('conformance');
	});

	it('parses a CommitResponse (extends OpsResponse)', () => {
		const v = CommitResponseSchema.parse({
			model_rev: 4,
			id_map: {},
			changed_elements: [],
			changed_relationships: [],
			deleted_element_ids: [],
			deleted_relationship_ids: [],
			issues_removed_owner_ids: [],
			issues_added: [],
			issue_counts: {},
			commit_id: 'c1',
			message: 'hi',
			validation_error_count: 0
		});
		expect(v.commit_id).toBe('c1');
		expect(v.model_rev).toBe(4);
	});
});
