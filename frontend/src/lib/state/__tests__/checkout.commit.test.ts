import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	ensureCheckout, setProjectInfo, resetCheckout, commitStaged, previewStaged,
	discardElement, getHeldTokens, isCheckedOutByMe,
	emit, seedElements, resetModelStore, getCachedElements, hasStagedOps
} from '../index';
import * as api from '$lib/api/checkout';

beforeEach(() => {
	resetModelStore();
	resetCheckout();
	setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
});

async function checkoutAndEdit() {
	vi.spyOn(api, 'acquireLocks').mockResolvedValue({
		token: 't1', leases: [{ resource_id: 'e1', mode: 'exclusive', holder: 'default-user', token: 't1', intent: 'edit', expires_at: 1 }]
	});
	seedElements([{ id: 'e1', type_name: 'T', properties: { name: 'a' }, rev: 1 }]);
	await ensureCheckout([{ resource_id: 'e1', mode: 'exclusive' }], 'edit');
	emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'b' } });
}

describe('commit lifecycle', () => {
	it('previewStaged sends the live rev + staged ops', async () => {
		await checkoutAndEdit();
		const spy = vi.spyOn(api, 'previewCommit').mockResolvedValue({ conformance_error_count: 0, structural_blockers: [], issues: [] });
		await previewStaged();
		expect(spy).toHaveBeenCalledOnce();
		const [rev, ops] = spy.mock.calls[0];
		expect(rev).toBe(0); // getModelRev after seed (no acked deltas)
		expect(ops).toHaveLength(1);
	});

	it('commitStaged applies the delta, clears the buffer + registry', async () => {
		await checkoutAndEdit();
		vi.spyOn(api, 'commitChanges').mockResolvedValue({
			model_rev: 1, id_map: {},
			changed_elements: [{ id: 'e1', type_name: 'T', properties: { name: 'b' }, rev: 2 }],
			changed_relationships: [], deleted_element_ids: [], deleted_relationship_ids: [],
			issues_removed_owner_ids: [], issues_added: [], issue_counts: {},
			commit_id: 'c1', message: 'm', validation_error_count: 0
		});
		await commitStaged('m', false);
		expect(hasStagedOps()).toBe(false);
		expect(getHeldTokens()).toEqual([]);
		expect(isCheckedOutByMe('e1')).toBe(false);
		expect(getCachedElements().get('e1')?.rev).toBe(2);
	});

	it('commitStaged passes all held tokens + ack_errors', async () => {
		await checkoutAndEdit();
		const spy = vi.spyOn(api, 'commitChanges').mockResolvedValue({
			model_rev: 1, id_map: {}, changed_elements: [], changed_relationships: [],
			deleted_element_ids: [], deleted_relationship_ids: [], issues_removed_owner_ids: [],
			issues_added: [], issue_counts: {}, commit_id: 'c1', message: 'm', validation_error_count: 3
		});
		await commitStaged('m', true);
		expect(spy.mock.calls[0][0]).toMatchObject({ message: 'm', lockTokens: ['t1'], ackErrors: true });
	});

	it('discardElement reverts that element and releases its token', async () => {
		await checkoutAndEdit();
		const rel = vi.spyOn(api, 'releaseLock').mockResolvedValue(undefined);
		await discardElement('e1');
		expect(rel).toHaveBeenCalledWith('t1', undefined);
		expect(getCachedElements().get('e1')?.properties.name).toBe('a'); // reverted
		expect(isCheckedOutByMe('e1')).toBe(false);
		expect(hasStagedOps()).toBe(false);
	});
});
