import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as modelReadApi from '$lib/api/model-read';

import { isProjectQuiet } from '../quiet';
import { hasModelLocks, handleFeedEvent, resetRealtime } from '../realtime.svelte';
import { emit, getStagedDepth, resetModelStore, seedElements } from '../model.svelte';
import { resetArtifactEdits, stageArtifactCreate } from '../artifact-edits.svelte';
import { resetViewEdits, stageViewOp } from '../view-edits.svelte';
import {
	clearStagedNodeMoves,
	initMetamodelStage,
	registerMetamodelDraftProvider,
	stageNodeMove
} from '../metamodel-stage.svelte';
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
	resetViewEdits();
	// The metamodel stage is a module singleton with a localStorage mirror:
	// clear the store BEFORE re-opening it, or a previous case's staged moves
	// are restored straight back into the next one.
	localStorage.clear();
	initMetamodelStage('p1');
	clearStagedNodeMoves();
	registerMetamodelDraftProvider(() => ({ dirty: false, blob: '' }));
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

		// `mm` is EXCLUDED, mirroring the backend's `is_model_resource`
		// (locking.py), which does not count the metamodel lease as a
		// model-scope lease. Counting it here would let the swap drawer's
		// OWN `mm` lease disable its own Rebind button.
		snapshotWithLocks('mm');
		expect(hasModelLocks()).toBe(false);
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

	it('is not quiet with only staged VIEW ops (F-3)', () => {
		expect(isProjectQuiet()).toBe(true);
		stageViewOp({ kind: 'rename_folder', id: 'f1', name: 'New name' }, 'Rename folder');
		expect(isProjectQuiet()).toBe(false);
	});

	it('is not quiet with only a staged diagram node MOVE (spec 2026-08-16)', () => {
		// Metamodel ops ride the same `POST /commits` batch as everything else,
		// so a whole-model rewrite invalidates them by the same rev bump — the
		// identical argument the artifact and view terms rest on.
		expect(isProjectQuiet()).toBe(true);
		stageNodeMove('el:Pump', { x: 10, y: 20 });
		expect(isProjectQuiet()).toBe(false);
	});

	it('is not quiet while the metamodel YAML draft is dirty', () => {
		// The draft half of the same family: the editor registers a provider on
		// the stage module, and a dirty buffer is a staged `metamodel.rebind`.
		expect(isProjectQuiet()).toBe(true);
		registerMetamodelDraftProvider(() => ({ dirty: true, blob: 'elements: []\n' }));
		expect(isProjectQuiet()).toBe(false);
	});
});
