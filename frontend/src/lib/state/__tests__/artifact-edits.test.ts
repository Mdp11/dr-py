import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	stageArtifactCreate,
	stageArtifactUpdate,
	stageArtifactDelete,
	revertStagedArtifact,
	clearStagedArtifacts,
	discardAllStagedArtifacts,
	getStagedArtifactOps,
	getStagedArtifactEntries,
	getStagedArtifactDepth,
	hasStagedArtifactOp,
	overlayArtifactHeaders,
	stagedArtifactState,
	stagedCreateSourceTab,
	onArtifactCommit,
	notifyArtifactCommit,
	onArtifactStageDiscarded,
	onArtifactStagedDelete,
	resetArtifactEdits
} from '../artifact-edits.svelte';
import { isTempId } from '../ops';
import type { ArtifactHeader } from '$lib/api/types';

const header = (id: string, name = 'N'): ArtifactHeader => ({
	id,
	kind: 'table',
	name,
	artifact_rev: 1,
	updated_at: '2026-08-06T00:00:00Z',
	updated_by: null,
	entry_points: null
});

beforeEach(() => resetArtifactEdits());

it('stages a create as one op with a temp id', () => {
	const tempId = stageArtifactCreate('table', 'T', { v: 1 }, 'tbl:draft:1');
	expect(isTempId(tempId)).toBe(true);
	expect(getStagedArtifactOps()).toEqual([
		{
			kind: 'create_artifact',
			temp_id: tempId,
			artifact_kind: 'table',
			name: 'T',
			payload: { v: 1 }
		}
	]);
});

it('coalesces update-over-create into the create (backend 422s the pair)', () => {
	const tempId = stageArtifactCreate('table', 'T', { v: 1 }, null);
	stageArtifactUpdate(tempId, { name: 'T2', payload: { v: 2 } });
	expect(getStagedArtifactOps()).toEqual([
		{
			kind: 'create_artifact',
			temp_id: tempId,
			artifact_kind: 'table',
			name: 'T2',
			payload: { v: 2 }
		}
	]);
});

it('coalesces update-over-update, keeping earlier fields the later omits', () => {
	stageArtifactUpdate('a1', { payload: { v: 2 } });
	stageArtifactUpdate('a1', { name: 'renamed' });
	expect(getStagedArtifactOps()).toEqual([
		{ kind: 'update_artifact', id: 'a1', name: 'renamed', payload: { v: 2 } }
	]);
});

it('delete-over-create drops both (never existed server-side)', () => {
	const tempId = stageArtifactCreate('table', 'T', {}, null);
	stageArtifactDelete(tempId, header(tempId));
	expect(getStagedArtifactDepth()).toBe(0);
});

it('delete-over-update collapses to delete', () => {
	stageArtifactUpdate('a1', { name: 'x' });
	stageArtifactDelete('a1', header('a1'));
	expect(getStagedArtifactOps()).toEqual([{ kind: 'delete_artifact', id: 'a1' }]);
});

it('overlay: renames applied, deletes hidden, creates appended', () => {
	const tempId = stageArtifactCreate('table', 'New', {}, null);
	stageArtifactUpdate('a1', { name: 'Renamed' });
	stageArtifactDelete('a2', header('a2'));
	const out = overlayArtifactHeaders([header('a1', 'Old'), header('a2')]);
	expect(out.map((h) => [h.id, h.name])).toEqual([
		['a1', 'Renamed'],
		[tempId, 'New']
	]);
	expect(stagedArtifactState('a1')).toBe('edited');
	expect(stagedArtifactState(tempId)).toBe('new');
	expect(stagedArtifactState('a2')).toBe('deleted');
});

it('revert fires the discard listener; clear (commit path) does not', () => {
	const seen: string[] = [];
	onArtifactStageDiscarded((id) => seen.push(id));
	stageArtifactUpdate('a1', { name: 'x' });
	revertStagedArtifact('a1');
	expect(seen).toEqual(['a1']);
	stageArtifactUpdate('a2', { name: 'y' });
	clearStagedArtifacts();
	expect(seen).toEqual(['a1']); // unchanged
	expect(getStagedArtifactDepth()).toBe(0);
});

describe('additional coalescing + edge cases', () => {
	it('a bare update-only op omits both name and payload keys when only one is set (name-only)', () => {
		stageArtifactUpdate('a1', { name: 'renamed-only' });
		expect(getStagedArtifactOps()).toEqual([
			{ kind: 'update_artifact', id: 'a1', name: 'renamed-only' }
		]);
		// explicitly assert the payload key is truly ABSENT, not present-as-undefined
		expect('payload' in getStagedArtifactOps()[0]).toBe(false);
	});

	it('a bare update-only op omits the name key when only payload is set (payload-only)', () => {
		stageArtifactUpdate('a1', { payload: { v: 9 } });
		expect(getStagedArtifactOps()).toEqual([
			{ kind: 'update_artifact', id: 'a1', payload: { v: 9 } }
		]);
		expect('name' in getStagedArtifactOps()[0]).toBe(false);
	});

	it('stageArtifactUpdate against an already-staged delete warns and is ignored', () => {
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		stageArtifactDelete('a1', header('a1'));
		stageArtifactUpdate('a1', { name: 'too-late' });
		expect(getStagedArtifactOps()).toEqual([{ kind: 'delete_artifact', id: 'a1' }]);
		expect(warnSpy).toHaveBeenCalledOnce();
		warnSpy.mockRestore();
	});

	it('delete-over-delete stays a single delete entry', () => {
		stageArtifactDelete('a1', header('a1'));
		stageArtifactDelete('a1', header('a1', 'renamed-before-delete'));
		expect(getStagedArtifactDepth()).toBe(1);
		expect(getStagedArtifactOps()).toEqual([{ kind: 'delete_artifact', id: 'a1' }]);
	});

	it('hasStagedArtifactOp reflects presence per id', () => {
		expect(hasStagedArtifactOp('a1')).toBe(false);
		stageArtifactUpdate('a1', { name: 'x' });
		expect(hasStagedArtifactOp('a1')).toBe(true);
		expect(hasStagedArtifactOp('a2')).toBe(false);
	});

	it('getStagedArtifactEntries exposes raw entries in insertion order', () => {
		const tempId = stageArtifactCreate('navigation', 'N', {}, 'tab-1');
		stageArtifactUpdate('a1', { name: 'x' });
		const entries = getStagedArtifactEntries();
		expect(entries.map((e) => e.kind)).toEqual(['create', 'update']);
		expect(entries[0]).toMatchObject({ kind: 'create', tempId, sourceTabId: 'tab-1' });
	});

	it('stagedCreateSourceTab returns the originating tab id, or null for a non-create/unknown id', () => {
		const tempId = stageArtifactCreate('code_snippet', 'S', {}, 'tab-9');
		expect(stagedCreateSourceTab(tempId)).toBe('tab-9');
		expect(stagedCreateSourceTab('does-not-exist')).toBeNull();
		stageArtifactUpdate('a1', { name: 'x' });
		expect(stagedCreateSourceTab('a1')).toBeNull();
	});

	it('stagedArtifactState returns null for an untouched id', () => {
		expect(stagedArtifactState('unknown')).toBeNull();
	});

	it('stageArtifactDelete fires onArtifactStagedDelete for both real and dropped-temp ids', () => {
		const seen: string[] = [];
		onArtifactStagedDelete((id) => seen.push(id));
		stageArtifactDelete('a1', header('a1'));
		const tempId = stageArtifactCreate('table', 'T', {}, null);
		stageArtifactDelete(tempId, header(tempId));
		expect(seen).toEqual(['a1', tempId]);
	});

	it('discardAllStagedArtifacts fires the discard listener per staged entry and clears the buffer', () => {
		const seen: string[] = [];
		onArtifactStageDiscarded((id) => seen.push(id));
		const tempId = stageArtifactCreate('table', 'T', {}, null);
		stageArtifactUpdate('a1', { name: 'x' });
		stageArtifactDelete('a2', header('a2'));
		discardAllStagedArtifacts();
		expect(seen).toHaveLength(3);
		expect(seen).toEqual(expect.arrayContaining([tempId, 'a1', 'a2']));
		expect(getStagedArtifactDepth()).toBe(0);
	});

	it('onArtifactCommit listeners fire with the full commit info via notifyArtifactCommit', () => {
		const seen: Array<{
			idMap: Record<string, string>;
			changed: ArtifactHeader[];
			deletedIds: string[];
		}> = [];
		const unsubscribe = onArtifactCommit((info) => seen.push(info));
		const info = { idMap: { tmp_1: 'a1' }, changed: [header('a1')], deletedIds: ['a2'] };
		notifyArtifactCommit(info);
		expect(seen).toEqual([info]);
		unsubscribe();
		notifyArtifactCommit(info);
		expect(seen).toHaveLength(1); // unsubscribed listener does not fire again
	});

	it('resetArtifactEdits clears staged state but not listener subscriptions', () => {
		const seen: string[] = [];
		onArtifactStageDiscarded((id) => seen.push(id));
		stageArtifactUpdate('a1', { name: 'x' });
		resetArtifactEdits();
		expect(getStagedArtifactDepth()).toBe(0);
		// the listener registered above is STILL subscribed after reset
		stageArtifactUpdate('a2', { name: 'y' });
		revertStagedArtifact('a2');
		expect(seen).toEqual(['a2']);
	});

	it('overlayArtifactHeaders synthesizes entry_points: null for staged creates (server-derived, invisible to ref filters until committed)', () => {
		const tempId = stageArtifactCreate('code_snippet', 'Snippet', {}, null);
		const out = overlayArtifactHeaders([]);
		expect(out).toEqual([
			expect.objectContaining({
				id: tempId,
				kind: 'code_snippet',
				name: 'Snippet',
				entry_points: null
			})
		]);
	});
});
