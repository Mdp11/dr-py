import { afterEach, describe, expect, it } from 'vitest';

import type { Element, OpsResponse, Relationship } from '$lib/api/types';
import {
	adoptSummary,
	applyDeltaShared,
	getIssueCounts,
	getIssuesByOwner,
	getLiveIssues,
	getModelGeneration,
	getModelRev,
	getModelSummary,
	getStructureRev,
	markStructureChanged,
	resetSharedStore
} from '../model-shared.svelte';
import { getOverlay, setOverlay } from '../validation.svelte';

afterEach(() => {
	resetSharedStore();
});

function el(id: string): Element {
	return { id, type_name: 'Block', properties: {}, rev: 0 };
}

function rel(id: string, source: string, target: string): Relationship {
	return { id, type_name: 'Link', source_id: source, target_id: target, properties: {}, rev: 0 };
}

function delta(partial: Partial<OpsResponse> = {}): OpsResponse {
	return {
		model_rev: partial.model_rev ?? getModelRev() + 1,
		id_map: {},
		changed_elements: [],
		changed_relationships: [],
		deleted_element_ids: [],
		deleted_relationship_ids: [],
		issues_removed_owner_ids: [],
		issues_added: [],
		issue_counts: {},
		...partial
	};
}

describe('applyDeltaShared', () => {
	it('bumps model rev, patches the summary, applies the issue delta, and clears the overlay', () => {
		adoptSummary({
			model_rev: 0,
			element_count: 0,
			relationship_count: 0,
			elements_by_type: {},
			issue_counts: {},
			undo_depth: 0
		});
		setOverlay([
			{ severity: 'error', message: 'stale', target_ids: ['x'], check: '', origin: 'uncommitted' }
		]);

		applyDeltaShared(
			delta({
				model_rev: 5,
				issue_counts: { error: 1 },
				issues_added: [
					{ severity: 'error', message: 'm', target_ids: ['a'], check: '', origin: 'on_server' }
				]
			}),
			() => true
		);

		expect(getModelRev()).toBe(5);
		expect(getModelSummary()).toMatchObject({ model_rev: 5, issue_counts: { error: 1 } });
		expect(getIssuesByOwner().get('a')).toHaveLength(1);
		expect(getLiveIssues()).toHaveLength(1);
		expect(getIssueCounts()).toEqual({ error: 1 });
		expect(getOverlay()).toBeNull();
	});

	it('removes issues for owners the delta names removed', () => {
		applyDeltaShared(
			delta({
				issues_added: [
					{ severity: 'error', message: 'm', target_ids: ['a'], check: '', origin: 'on_server' }
				]
			}),
			() => true
		);

		applyDeltaShared(delta({ issues_removed_owner_ids: ['a'] }), () => true);

		expect(getIssuesByOwner().has('a')).toBe(false);
	});

	it("replaces an added issue's owner whole, though the removed ids do not name it", () => {
		const issue = (message: string, owner: string, origin: 'on_server' | 'uncommitted') => ({
			severity: 'error' as const,
			message,
			target_ids: [owner],
			check: 'rule:r',
			origin
		});
		// The engine's list: its own copy of an issue on `a`, which the server held none for.
		applyDeltaShared(
			delta({ issues_added: [issue('m', 'a', 'uncommitted'), issue('k', 'b', 'uncommitted')] }),
			() => true
		);

		applyDeltaShared(
			delta({ issues_added: [issue('m', 'a', 'on_server'), issue('n', 'a', 'on_server')] }),
			() => true
		);

		expect(getLiveIssues()).toEqual([
			issue('k', 'b', 'uncommitted'),
			issue('m', 'a', 'on_server'),
			issue('n', 'a', 'on_server')
		]);
	});

	describe('the structure rev', () => {
		it('bumps on an id_map', () => {
			const before = getStructureRev();
			applyDeltaShared(delta({ id_map: { tmp1: 'e1' } }), () => true);
			expect(getStructureRev()).toBe(before + 1);
		});

		it('bumps on a changed relationship', () => {
			const before = getStructureRev();
			applyDeltaShared(delta({ changed_relationships: [rel('r1', 'e1', 'e2')] }), () => true);
			expect(getStructureRev()).toBe(before + 1);
		});

		it('bumps on a deleted element', () => {
			const before = getStructureRev();
			applyDeltaShared(delta({ deleted_element_ids: ['e1'] }), () => true);
			expect(getStructureRev()).toBe(before + 1);
		});

		it('bumps on a deleted relationship', () => {
			const before = getStructureRev();
			applyDeltaShared(delta({ deleted_relationship_ids: ['r1'] }), () => true);
			expect(getStructureRev()).toBe(before + 1);
		});

		it('bumps on a changed element the caller has not seen before', () => {
			const before = getStructureRev();
			applyDeltaShared(delta({ changed_elements: [el('e1')] }), () => false);
			expect(getStructureRev()).toBe(before + 1);
		});

		it('does not bump on a property-only change to an already-cached element', () => {
			const before = getStructureRev();
			applyDeltaShared(delta({ changed_elements: [el('e1')] }), () => true);
			expect(getStructureRev()).toBe(before);
		});
	});
});

describe('markStructureChanged', () => {
	it('bumps the structure rev', () => {
		const before = getStructureRev();
		markStructureChanged();
		expect(getStructureRev()).toBe(before + 1);
	});
});

describe('resetSharedStore', () => {
	it('drops the summary, rev, issues and error, and bumps the generation', () => {
		adoptSummary({
			model_rev: 3,
			element_count: 0,
			relationship_count: 0,
			elements_by_type: {},
			issue_counts: { error: 1 },
			undo_depth: 0
		});
		applyDeltaShared(
			delta({
				issues_added: [
					{ severity: 'error', message: 'm', target_ids: ['a'], check: '', origin: 'on_server' }
				]
			}),
			() => true
		);
		const gen = getModelGeneration();

		resetSharedStore();

		expect(getModelSummary()).toBeNull();
		expect(getModelRev()).toBe(0);
		expect(getStructureRev()).toBe(0);
		expect(getIssueCounts()).toBeNull();
		expect(getIssuesByOwner().size).toBe(0);
		expect(getModelGeneration()).toBe(gen + 1);
	});
});
