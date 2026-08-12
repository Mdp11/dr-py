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
import {
	clearOverlay,
	getLastError,
	getLastRunAt,
	getOverlay,
	setLastError,
	setOverlay
} from '../validation.svelte';

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
	clearOverlay();
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
		setOverlay([issue('snapshot', 'e1')]);
		expect(getLastRunAt()).not.toBeNull();
		adoptIssues([], {}, 1);
		expect(getLastRunAt()).toBeNull();
	});
});

describe('clearOverlay keeps lastError (a failed Validate must survive a peer commit)', () => {
	it('drops the overlay and lastRunAt but not lastError', () => {
		summaryAtRev(1);
		setOverlay([issue('snapshot', 'e1')]);
		setLastError('validate failed: boom');
		clearOverlay();
		expect(getOverlay()).toBeNull();
		expect(getLastRunAt()).toBeNull();
		expect(getLastError()).toBe('validate failed: boom');
	});
});

describe('applyDelta clears the Validate overlay', () => {
	it('a commit delta invalidates the staged snapshot', () => {
		summaryAtRev(1);
		setOverlay([issue('snapshot', 'e1')]);
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

describe('resetModelStore clears the Validate overlay', () => {
	it('a different model is being installed, so the staged snapshot is moot', () => {
		summaryAtRev(1);
		setOverlay([issue('project A staged', 'e1')]);
		resetModelStore();
		// The overlay WINS over the live map in every consumer, so surviving the
		// reset would render project A's issues across project B's whole UI —
		// permanently if B's best-effort refetch fails.
		expect(getOverlay()).toBeNull();
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

	it('drops a response that lands after a store reset (project switch)', async () => {
		summaryAtRev(7);
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		vi.spyOn(validationApi, 'getModelIssues').mockImplementation(async () => {
			await gate;
			return {
				model_rev: 7,
				issues: [issue('project A', 'e1')],
				counts: { error: 1 },
				truncated: false
			};
		});

		const inFlight = refetchIssues();
		resetModelStore(); // switched to project B mid-flight
		release();
		await inFlight;

		// The rev guard in adoptIssues cannot catch this — the reset put the
		// store's rev back to 0, so ANY response rev passes it. The generation
		// capture is what drops it.
		expect(getLiveIssues()).toHaveLength(0);
		expect(getIssueCounts()).toBeNull();
	});
});
