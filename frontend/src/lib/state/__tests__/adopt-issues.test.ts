import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as validationApi from '$lib/api/validation';
import type { Issue } from '$lib/api/types';
import {
	adoptIssues,
	adoptSummary,
	applyDelta,
	getIssueCounts,
	getIssuesByOwner,
	getIssuesTruncatedTotal,
	getLiveIssues,
	refetchIssues,
	resetModelStore
} from '../model.svelte';
import { clearIssues, getLastRunAt, setIssues } from '../validation.svelte';

function issue(message: string, owner: string): Issue {
	return { severity: 'error', message, target_ids: [owner], origin: 'on_server' };
}

function summaryAtRev(rev: number): void {
	adoptSummary({
		model_rev: rev,
		element_count: 0,
		relationship_count: 0,
		elements_by_type: {},
		issue_counts: null,
		undo_depth: 0
	});
}

beforeEach(() => {
	resetModelStore();
	clearIssues();
	vi.restoreAllMocks();
});

describe('adoptIssues', () => {
	it('refills the live map and counts', () => {
		summaryAtRev(3);
		adoptIssues([issue('boom', 'e1'), issue('bam', 'e1'), issue('pow', 'e2')], { error: 3 }, 3);
		expect(getIssuesByOwner().get('e1')).toHaveLength(2);
		expect(getIssuesByOwner().get('e2')).toHaveLength(1);
		expect(getLiveIssues()).toHaveLength(3);
		expect(getIssueCounts()).toEqual({ error: 3 });
		expect(getIssuesTruncatedTotal()).toBeNull();
	});

	it('drops a response older than the store rev (race with a commit splice)', () => {
		summaryAtRev(5);
		adoptIssues([issue('current', 'e1')], { error: 1 }, 5);
		adoptIssues([issue('stale', 'e9')], { error: 1 }, 4);
		expect(getLiveIssues()[0].message).toBe('current');
	});

	it('accepts an equal-rev response (sweep splices without a rev bump)', () => {
		summaryAtRev(5);
		adoptIssues([issue('a', 'e1')], { error: 1 }, 5);
		adoptIssues([issue('a', 'e1'), issue('b', 'e2')], { error: 2 }, 5);
		expect(getLiveIssues()).toHaveLength(2);
	});

	it('records the exact total when truncated', () => {
		summaryAtRev(1);
		adoptIssues([issue('a', 'e1')], { error: 40, warning: 2 }, 1, true);
		expect(getIssuesTruncatedTotal()).toBe(42);
	});

	it('clears the Validate overlay (committed truth moved)', () => {
		summaryAtRev(1);
		setIssues([issue('snapshot', 'e1')]);
		expect(getLastRunAt()).not.toBeNull();
		adoptIssues([], {}, 1);
		expect(getLastRunAt()).toBeNull();
	});
});

describe('applyDelta clears the Validate overlay', () => {
	it('a commit delta invalidates the staged snapshot', () => {
		summaryAtRev(1);
		setIssues([issue('snapshot', 'e1')]);
		applyDelta({
			model_rev: 2,
			id_map: {},
			changed_elements: [],
			changed_relationships: [],
			deleted_element_ids: [],
			deleted_relationship_ids: [],
			issues_removed_owner_ids: [],
			issues_added: [],
			issue_counts: {}
		});
		expect(getLastRunAt()).toBeNull();
	});
});

describe('refetchIssues', () => {
	it('fetches GET /model/issues and adopts the result', async () => {
		summaryAtRev(1);
		vi.spyOn(validationApi, 'getModelIssues').mockResolvedValue({
			model_rev: 1,
			issues: [issue('fetched', 'e1')],
			counts: { error: 1 },
			truncated: false
		});
		await refetchIssues();
		expect(getLiveIssues()[0].message).toBe('fetched');
		expect(getIssueCounts()).toEqual({ error: 1 });
	});

	it('swallows fetch errors and keeps the current map', async () => {
		summaryAtRev(1);
		adoptIssues([issue('kept', 'e1')], { error: 1 }, 1);
		vi.spyOn(validationApi, 'getModelIssues').mockRejectedValue(new Error('down'));
		await refetchIssues();
		expect(getLiveIssues()[0].message).toBe('kept');
	});
});
