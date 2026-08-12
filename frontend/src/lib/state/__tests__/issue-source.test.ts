import { beforeEach, describe, expect, it } from 'vitest';
import type { Issue } from '$lib/api/types';
import { getEffectiveIssues } from '../issue-source';
import { adoptIssues, adoptSummary, resetModelStore } from '../model.svelte';
import { clearOverlay, setOverlay } from '../validation.svelte';

function issue(message: string, origin: Issue['origin'] = 'on_server'): Issue {
	return { severity: 'error', message, target_ids: ['e1'], origin };
}

beforeEach(() => {
	resetModelStore();
	clearOverlay();
	adoptSummary({
		model_rev: 1,
		element_count: 0,
		relationship_count: 0,
		elements_by_type: {},
		issue_counts: null,
		undo_depth: 0
	});
});

describe('getEffectiveIssues', () => {
	it('serves the live map when no overlay is set', () => {
		adoptIssues([issue('live')], { error: 1 }, 1);
		expect(getEffectiveIssues().map((i) => i.message)).toEqual(['live']);
	});

	it('an explicit Validate overlay wins over the live map', () => {
		adoptIssues([issue('live')], { error: 1 }, 1);
		setOverlay([issue('staged', 'uncommitted'), issue('gone', 'resolved')]);
		expect(getEffectiveIssues().map((i) => i.message)).toEqual(['staged', 'gone']);
	});

	it('adopting committed truth clears the overlay back to live', () => {
		setOverlay([issue('staged', 'uncommitted')]);
		adoptIssues([issue('live')], { error: 1 }, 1);
		expect(getEffectiveIssues().map((i) => i.message)).toEqual(['live']);
	});

	it('an EMPTY overlay is still an overlay (clean staged validate)', () => {
		adoptIssues([issue('live')], { error: 1 }, 1);
		setOverlay([]);
		expect(getEffectiveIssues()).toEqual([]);
	});
});
