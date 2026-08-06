import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as modelReadApi from '$lib/api/model-read';

import { isProjectQuiet } from '../quiet';
import { hasModelLocks, handleFeedEvent, resetRealtime } from '../realtime.svelte';
import { emit, getStagedDepth, resetModelStore, seedElements } from '../model.svelte';
import { resetArtifactEdits, stageArtifactCreate } from '../artifact-edits.svelte';
import type { LeaseLite } from '$lib/api/feed';

/**
 * The quiet-project gate (history Revert / metamodel Swap). The case that
 * matters is the third term: an `art:` lease is a peer with an artifact editor
 * tab open, which is NOT a reason to disable a model-scope rewrite for the
 * whole project.
 */

function lease(resourceId: string): LeaseLite {
	return {
		resource_id: resourceId,
		mode: 'exclusive',
		holder_id: 'someone-else',
		holder_email: 'peer@x.io'
	};
}

function snapshotWithLocks(...resourceIds: string[]): void {
	handleFeedEvent({
		type: 'snapshot',
		model_rev: 0,
		locks: resourceIds.map(lease),
		connected: []
	});
}

beforeEach(() => {
	resetRealtime();
	resetModelStore();
	resetArtifactEdits();
	// A snapshot ahead of the cached rev fires a fire-and-forget summary
	// refresh; keep it off the network.
	vi.spyOn(modelReadApi, 'getModelSummary').mockResolvedValue({
		model_rev: 1,
		element_count: 0,
		relationship_count: 0,
		elements_by_type: {},
		issue_counts: null,
		undo_depth: 0
	});
});

describe('hasModelLocks', () => {
	it('is false for an empty lock table', () => {
		expect(hasModelLocks()).toBe(false);
	});

	it('ignores art: leases and reports model-scope ones', () => {
		snapshotWithLocks('art:a9');
		expect(hasModelLocks()).toBe(false);

		snapshotWithLocks('art:a9', 'e1');
		expect(hasModelLocks()).toBe(true);

		// `mm` (the metamodel lock namespace) is model scope too.
		snapshotWithLocks('mm');
		expect(hasModelLocks()).toBe(true);
	});
});

describe('isProjectQuiet', () => {
	it('is true with nothing staged and no lease at all', () => {
		expect(isProjectQuiet()).toBe(true);
	});

	it('STAYS QUIET while only art: leases are live (regression)', () => {
		// The branch-introduced regression: every open navigation/table/snippet
		// tab takes an `art:` lease, so counting them here disabled Revert and
		// Swap-metamodel project-wide for the full lock TTL.
		snapshotWithLocks('art:a9', 'art:a10');
		expect(isProjectQuiet()).toBe(true);
	});

	it('is false while a model-scope lease is live', () => {
		snapshotWithLocks('e1');
		expect(isProjectQuiet()).toBe(false);
	});

	it('is false while a model op is staged', () => {
		seedElements([{ id: 'e1', type_name: 'T', properties: { name: 'a' }, rev: 1 }]);
		emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'b' } });
		expect(getStagedDepth()).toBe(1);
		expect(isProjectQuiet()).toBe(false);
	});

	it('is false while an ARTIFACT op is staged, even with no lease', () => {
		// Artifact ops ride the same commit batch, so a rev bump invalidates them
		// exactly like a model op — this term must survive the art:-lease fix.
		stageArtifactCreate('table', 'T', {}, null);
		expect(isProjectQuiet()).toBe(false);
	});
});
