import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as lockApi from '$lib/api/checkout';
import { ConflictError } from '$lib/api/errors';
import * as mmApi from '$lib/api/metamodel';
import type { LockResponse } from '$lib/api/types';
import { FIXTURE } from '$lib/metamodel/__tests__/fixtures';
import { lineRangeForType, parseDraft } from '$lib/metamodel/yaml-edit';
import { isCheckedOutByMe, resetCheckout, setProjectInfo } from '../checkout.svelte';
import {
	clearStagedNodeMoves,
	getStagedMetamodelOps,
	notifyMetamodelCommitted
} from '../metamodel-stage.svelte';
import {
	applyDiagramEdit,
	closeMetamodelDiagram,
	getMetamodelDiagramView,
	initMetamodelDiagram,
	moveNode,
	onMetamodelRebound,
	runAutoArrange,
	undoDiagramEdit
} from '../metamodel-diagram.svelte';

/**
 * The diagram half of the metamodel tab. This module owns NO draft state: it
 * parses the editor module's buffer,
 * applies one semantic YAML command, and writes the text back through
 * `editMetamodelBuffer`. So the editor module is MOCKED down to the two
 * functions that seam touches — a tiny in-test buffer store — which keeps these
 * tests about the diagram module's own behaviour (commands, undo, staged
 * positions) rather than about the lease/lint/draft lifecycle that already has
 * its own suite (`metamodel-editor.test.ts`).
 *
 * Positions are STAGED, not PUT: a drag becomes a `metamodel.move_node` op in
 * `metamodel-stage.svelte.ts` and lands through `POST /commits`. So the
 * assertions below read the staged op list rather than a layout PUT spy; the
 * only layout call left is the baseline `GET`, which is spied (the precedent in
 * `metamodel-editor.test.ts`) so nothing reaches the network. The real
 * `getRole()` from `checkout.svelte` decides who may stage.
 */

const editorState = vi.hoisted(() => ({
	buffer: '',
	readOnly: false,
	/** The peer holding the `mm` lease, as the real module reports it. The
	 * diagram READS this (a staged move needs the same lease) and WRITES it
	 * through `noteMetamodelLockConflict` when its own layout acquire is the
	 * one that discovers the conflict. */
	lockedBy: null as string | null,
	/** The real module's load phase. `'error'` (with an EMPTY buffer) is the
	 * shape a failed metamodel load leaves behind, and `MetamodelTab.init()`
	 * calls `initMetamodelDiagram` in it regardless. */
	phase: 'ready' as 'idle' | 'loading' | 'ready' | 'error',
	/** Every ATTEMPTED write, counted before the early return below. The stub
	 * mirrors the real module's `isEditBlocked()`, which means the resulting
	 * buffer says nothing about whether the diagram module guarded — this
	 * counter is the signal that discriminates. */
	writes: 0,
	lintErrors: [] as { message: string; line: number | null; column: number | null }[]
}));

vi.mock('../metamodel-editor.svelte', () => ({
	getMetamodelEditor: () => ({
		buffer: editorState.buffer,
		readOnly: editorState.readOnly,
		phase: editorState.phase,
		lockedBy: editorState.lockedBy,
		lintErrors: editorState.lintErrors
	}),
	noteMetamodelLockConflict: (holder: string) => {
		editorState.lockedBy = holder;
	},
	editMetamodelBuffer: (code: string) => {
		editorState.writes++;
		// Mirrors the real module's `isEditBlocked()` early return, so the stub
		// cannot accept a write the real editor would drop.
		if (editorState.readOnly) return;
		editorState.buffer = code;
	}
}));

/** Only the move ops — the staged batch also carries a `metamodel.rebind` when
 * a draft provider is registered, which no test in this file does. */
function stagedMoves(): { node: string; pos: { x: number; y: number } | null }[] {
	return getStagedMetamodelOps()
		.filter((o) => o.kind === 'metamodel.move_node')
		.map((o) => ({ node: o.node, pos: o.pos }));
}

/** Mirrors metamodel-editor.test.ts's fixture: one exclusive `mm` lease, each
 * lease carrying its own token (what `LeaseOut` declares and what
 * `checkout.svelte`'s `_recordLeases` stores). */
const LEASE: LockResponse = {
	token: 't-mm',
	leases: [
		{
			resource_id: 'mm',
			mode: 'exclusive',
			holder: 'default-user',
			holder_email: 'default@example.com',
			token: 't-mm',
			intent: 'edit',
			expires_at: 1
		}
	]
};
const CONFLICT = new ConflictError(
	409,
	{
		detail: 'lock conflict',
		conflicts: [{ resource_id: 'mm', held_by: 'u2', held_by_email: 'peer@example.com' }]
	},
	'conflict'
);

beforeEach(() => {
	localStorage.clear();
	resetCheckout();
	setProjectInfo({ role: 'owner', lockTtlSeconds: 300 });
	// The stage is a module singleton shared with every other suite in this
	// worker; a leftover move would otherwise leak into the next case.
	clearStagedNodeMoves();
	editorState.buffer = FIXTURE;
	editorState.readOnly = false;
	editorState.lockedBy = null;
	editorState.phase = 'ready';
	editorState.writes = 0;
	editorState.lintErrors = [];
	// Staging a move acquires the `mm` lease, so every case that drags would
	// otherwise reach the network. Granted by default; the conflict cases
	// below re-spy with a 409.
	vi.spyOn(lockApi, 'acquireLocks').mockResolvedValue(LEASE);
});

afterEach(() => {
	closeMetamodelDiagram();
	clearStagedNodeMoves();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('applyDiagramEdit', () => {
	it('routes the command through the shared buffer and reparses it', () => {
		const ok = applyDiagramEdit({ kind: 'addElementType', name: 'Sensor' });

		expect(ok).toBe(true);
		expect(editorState.buffer).toContain('- name: Sensor');
		const v = getMetamodelDiagramView();
		expect(v.mm?.elements.map((e) => e.name)).toContain('Sensor');
		expect(v.parseErrors).toEqual([]);
		// The whole point of going through the yaml Document: comments survive.
		expect(editorState.buffer).toContain('## smart-city excerpt — file comment must survive');
		expect(editorState.buffer).toContain('# the abstract root');
	});

	it('refuses and leaves the buffer untouched when the surface is read-only', () => {
		editorState.readOnly = true;

		const ok = applyDiagramEdit({ kind: 'addElementType', name: 'Sensor' });

		expect(ok).toBe(false);
		// NOT `buffer === FIXTURE`: the stub drops a read-only write exactly as
		// the real module does, so the buffer is unchanged either way and that
		// assertion would pass with the diagram module's guard removed. What
		// discriminates is that no write was even attempted.
		expect(editorState.writes).toBe(0);
		expect(getMetamodelDiagramView().canUndo).toBe(false);
	});

	it('refuses while the buffer has parse errors (the canvas is a fallback then)', () => {
		editorState.buffer = 'elements: [\n';

		const ok = applyDiagramEdit({ kind: 'addElementType', name: 'Sensor' });

		expect(ok).toBe(false);
		expect(editorState.buffer).toBe('elements: [\n');
		const v = getMetamodelDiagramView();
		expect(v.mm).toBeNull();
		expect(v.parseErrors.length).toBeGreaterThan(0);
	});
});

describe('undoDiagramEdit', () => {
	it('restores the pre-edit buffer and flips canUndo back', () => {
		expect(getMetamodelDiagramView().canUndo).toBe(false);

		applyDiagramEdit({ kind: 'addElementType', name: 'Sensor' });
		expect(getMetamodelDiagramView().canUndo).toBe(true);

		undoDiagramEdit();

		expect(editorState.buffer).toBe(FIXTURE);
		expect(getMetamodelDiagramView().canUndo).toBe(false);
		expect(getMetamodelDiagramView().mm?.elements.map((e) => e.name)).not.toContain('Sensor');
	});

	it('re-stages the positions it restored, so the commit matches the canvas', () => {
		moveNode('el:Zone', { x: 5, y: 6 });
		expect(applyDiagramEdit({ kind: 'renameElementType', from: 'Zone', to: 'District' })).toBe(
			true
		);
		expect(stagedMoves()).toContainEqual({ node: 'el:District', pos: { x: 5, y: 6 } });

		undoDiagramEdit();

		// The canvas is back on `el:Zone`, and so is the staged batch — without
		// the re-stage the commit would still publish `el:District`.
		expect(getMetamodelDiagramView().positions['el:Zone']).toEqual({ x: 5, y: 6 });
		expect(stagedMoves()).toContainEqual({ node: 'el:Zone', pos: { x: 5, y: 6 } });
		expect(stagedMoves()).toContainEqual({ node: 'el:District', pos: null });
	});
});

describe('undoDiagramEdit read-only guard', () => {
	/**
	 * `applyDiagramEdit` guards on `readOnly`; the undo has to as well, and for
	 * a sharper reason than symmetry. It rolls `_positions` (and the staged
	 * moves derived from them) back unconditionally, but the buffer half goes
	 * through `editMetamodelBuffer`, which SILENTLY DROPS the write when the
	 * editor is blocked. Reachable: the `mm` lease is acquired asynchronously on
	 * the first divergent edit, so a rename can land and only then lose the race
	 * to a peer's lease.
	 */
	it('refuses while the surface is read-only, so the keys cannot desync from the draft', () => {
		moveNode('el:Zone', { x: 5, y: 6 });
		expect(applyDiagramEdit({ kind: 'renameElementType', from: 'Zone', to: 'District' })).toBe(
			true
		);
		editorState.writes = 0;

		// The lease acquire lost to a peer: the rename is already in the draft,
		// and the surface has just gone read-only underneath it.
		editorState.readOnly = true;

		undoDiagramEdit();

		// No write attempted (the counter, not the buffer, is what discriminates
		// — the stub drops a read-only write either way).
		expect(editorState.writes).toBe(0);
		// The draft still says District, so the key space must still say District.
		expect(editorState.buffer).toContain('- name: District');
		expect(getMetamodelDiagramView().positions['el:District']).toEqual({ x: 5, y: 6 });
		expect(getMetamodelDiagramView().canUndo).toBe(true);
		// And the staged batch was not rolled back either.
		expect(stagedMoves()).toContainEqual({ node: 'el:District', pos: { x: 5, y: 6 } });
	});
});

describe('moveNode', () => {
	it('a drag stages a coalesced move op instead of PUTting', () => {
		moveNode('el:Zone', { x: 10, y: 20 });
		moveNode('el:Zone', { x: 11, y: 21 });

		expect(getMetamodelDiagramView().positions['el:Zone']).toEqual({ x: 11, y: 21 });
		// Coalesced: the last position for a node is the only one that matters.
		expect(getStagedMetamodelOps()).toEqual([
			{ kind: 'metamodel.move_node', node: 'el:Zone', pos: { x: 11, y: 21 } }
		]);
	});

	it('has no layout PUT left to make', () => {
		// There is no `PUT /metamodel/layout` route, and no client wrapper for
		// one — a re-introduced live save would have to re-add it.
		expect('putMetamodelLayout' in mmApi).toBe(false);
	});
});

describe('the layout lease', () => {
	/**
	 * The merge-blocking hazard: `required_locks` (api/locking.py) derives an
	 * EXCLUSIVE `mm` lease for BOTH members of the
	 * `metamodel.*` family, so a staged move with no lease behind it 409s the
	 * WHOLE next commit — including unrelated model/artifact/view edits — and
	 * keeps doing so until the user finds the drawer's discard. The editor's
	 * own acquire cannot cover this: it is owner-gated, and an EDITOR is
	 * allowed to stage moves.
	 */
	it('acquires the mm lease on the first staged move, once per drag burst', async () => {
		const acquire = vi.spyOn(lockApi, 'acquireLocks').mockResolvedValue(LEASE);

		moveNode('el:Zone', { x: 10, y: 20 });
		// Synchronous: a drag never waits on the acquire (a pointer-move must
		// not block on a round trip).
		expect(stagedMoves()).toEqual([{ node: 'el:Zone', pos: { x: 10, y: 20 } }]);
		moveNode('el:Zone', { x: 11, y: 21 });
		moveNode('el:Ward', { x: 1, y: 2 });

		await vi.waitFor(() => expect(isCheckedOutByMe('mm')).toBe(true));
		expect(acquire).toHaveBeenCalledOnce(); // ONE call for the whole burst
		expect(acquire.mock.calls[0]?.[0]).toEqual({
			targets: [{ resource_id: 'mm', mode: 'exclusive', type: 'metamodel' }],
			intent: 'edit',
			steal: false
		});

		// Held now: further drags add nothing.
		moveNode('el:Ward', { x: 3, y: 4 });
		await Promise.resolve();
		expect(acquire).toHaveBeenCalledOnce();
	});

	it('acquires it for an auto-arrange too, and for the undo that re-stages', async () => {
		const acquire = vi.spyOn(lockApi, 'acquireLocks').mockResolvedValue(LEASE);
		vi.spyOn(mmApi, 'getMetamodelLayout').mockResolvedValue({
			positions: { 'el:Zone': { x: 0, y: 0 } }
		});
		await initMetamodelDiagram('p1');

		await runAutoArrange();

		await vi.waitFor(() => expect(isCheckedOutByMe('mm')).toBe(true));
		// One acquire for the whole arrangement, not one per arranged node.
		expect(acquire).toHaveBeenCalledOnce();
	});

	it('stages nothing — and drops what it optimistically staged — when a peer holds it', async () => {
		vi.spyOn(lockApi, 'acquireLocks').mockRejectedValue(CONFLICT);

		moveNode('el:Zone', { x: 10, y: 20 });
		// Optimistic until the refusal lands: the acquire is async and the drag is
		// not allowed to wait for it.
		expect(stagedMoves()).toEqual([{ node: 'el:Zone', pos: { x: 10, y: 20 } }]);

		await vi.waitFor(() => expect(editorState.lockedBy).toBe('peer@example.com'));

		// NOTHING staged: a move op that can never hold the lease it requires is
		// exactly the trap this fix is about.
		expect(stagedMoves()).toEqual([]);
		// ...but the canvas still responded to the drag — the position is LOCAL,
		// mirroring the editor's read-only fallback (which keeps typed characters).
		expect(getMetamodelDiagramView().positions['el:Zone']).toEqual({ x: 10, y: 20 });

		// And a further drag stays local too, with no second acquire attempt.
		moveNode('el:Zone', { x: 30, y: 40 });
		expect(stagedMoves()).toEqual([]);
		expect(getMetamodelDiagramView().positions['el:Zone']).toEqual({ x: 30, y: 40 });
	});
});

describe('a diagram rename', () => {
	it('migrates the layout key as two staged ops', () => {
		moveNode('el:Zone', { x: 5, y: 6 });

		expect(applyDiagramEdit({ kind: 'renameElementType', from: 'Zone', to: 'District' })).toBe(
			true
		);

		// Local canvas follows the rename immediately (no jump to a fresh spot)...
		const v = getMetamodelDiagramView();
		expect(v.positions['el:District']).toEqual({ x: 5, y: 6 });
		expect(v.positions['el:Zone']).toBeUndefined();

		// ...and the key migrates WITH the rename, in the same commit batch: the
		// old key is dropped and the new one claims the position. No deferral.
		const ops = getStagedMetamodelOps().filter((o) => o.kind === 'metamodel.move_node');
		expect(ops).toContainEqual({ kind: 'metamodel.move_node', node: 'el:Zone', pos: null });
		expect(ops.find((o) => o.node === 'el:District')?.pos).toEqual({ x: 5, y: 6 });
	});

	it('stages a bare key drop for a deleted type', () => {
		moveNode('el:Building', { x: 3, y: 4 });

		expect(applyDiagramEdit({ kind: 'removeElementType', name: 'Building' })).toBe(true);

		expect(stagedMoves()).toContainEqual({ node: 'el:Building', pos: null });
		expect(stagedMoves().find((o) => o.node === 'el:Building')?.pos).toBeNull();
	});
});

describe('initMetamodelDiagram', () => {
	it('overlays restored staged moves on the fetched baseline', async () => {
		localStorage.setItem(
			'ui.metamodel.layoutdraft.p1',
			JSON.stringify([
				['el:Zone', { x: -500, y: -700 }],
				['el:Building', null]
			])
		);
		vi.spyOn(mmApi, 'getMetamodelLayout').mockResolvedValue({
			positions: { 'el:Zone': { x: 1, y: 1 }, 'el:Building': { x: 2, y: 2 } }
		});

		await initMetamodelDiagram('p1');

		const v = getMetamodelDiagramView();
		// The staged position wins over the baseline...
		expect(v.positions['el:Zone']).toEqual({ x: -500, y: -700 });
		// ...and a staged key DROP removes the baseline entry (the node is then
		// placed heuristically by `placeUnpositioned`, never left at (2,2)).
		expect(v.positions['el:Building']).not.toEqual({ x: 2, y: 2 });
		// The restored moves are still staged — init must not consume them.
		expect(stagedMoves()).toContainEqual({ node: 'el:Zone', pos: { x: -500, y: -700 } });
		expect(stagedMoves()).toContainEqual({ node: 'el:Building', pos: null });
	});

	/**
	 * A never-arranged diagram auto-arranges on first open. That arrangement is
	 * LOCAL ONLY: if it staged, merely OPENING the tab would manufacture a
	 * pending commit (and a dirty commit drawer) out of nothing the user did.
	 */
	it('auto-arranges a never-arranged diagram without staging anything', async () => {
		vi.spyOn(mmApi, 'getMetamodelLayout').mockResolvedValue({ positions: {} });

		await initMetamodelDiagram('p1');

		expect(Object.keys(getMetamodelDiagramView().positions).length).toBeGreaterThan(0);
		expect(getStagedMetamodelOps()).toEqual([]);
	});

	it('stages nothing when the baseline GET fails either', async () => {
		vi.spyOn(mmApi, 'getMetamodelLayout').mockRejectedValue(new Error('boom'));

		await initMetamodelDiagram('p1');

		// The arrange still happened — a local canvas beats stacking every box at
		// the origin — but nothing is proposed for commit.
		expect(Object.keys(getMetamodelDiagramView().positions).length).toBeGreaterThan(0);
		expect(getStagedMetamodelOps()).toEqual([]);
	});
});

describe('runAutoArrange', () => {
	it('stages every arranged node (it is a deliberate user gesture)', async () => {
		vi.spyOn(mmApi, 'getMetamodelLayout').mockResolvedValue({
			positions: { 'el:Zone': { x: 0, y: 0 } }
		});
		await initMetamodelDiagram('p1');
		expect(getStagedMetamodelOps()).toEqual([]);

		await runAutoArrange();

		const positions = getMetamodelDiagramView().positions;
		const moves = stagedMoves();
		expect(moves.length).toBeGreaterThan(1);
		for (const m of moves) expect(positions[m.node]).toEqual(m.pos);
	});
});

describe('a landed commit', () => {
	it('re-derives the positions from the refetched baseline', async () => {
		const get = vi
			.spyOn(mmApi, 'getMetamodelLayout')
			.mockResolvedValue({ positions: { 'el:Zone': { x: 1, y: 1 } } });
		await initMetamodelDiagram('p1');
		get.mockResolvedValue({ positions: { 'el:Zone': { x: 8, y: 9 } } });
		// checkout clears the staged copy before it notifies.
		clearStagedNodeMoves();

		notifyMetamodelCommitted({ rebound: false, blob: null });
		await vi.waitFor(() =>
			expect(getMetamodelDiagramView().positions['el:Zone']).toEqual({ x: 8, y: 9 })
		);
	});

	it('drops the undo history when the commit carried a rebind', async () => {
		vi.spyOn(mmApi, 'getMetamodelLayout').mockResolvedValue({
			positions: { 'el:Zone': { x: 1, y: 1 } }
		});
		await initMetamodelDiagram('p1');
		expect(applyDiagramEdit({ kind: 'renameElementType', from: 'Zone', to: 'District' })).toBe(
			true
		);
		expect(getMetamodelDiagramView().canUndo).toBe(true);

		notifyMetamodelCommitted({ rebound: true, blob: 'whatever' });

		// The stack's snapshots were taken against a baseline the rebind moved.
		expect(getMetamodelDiagramView().canUndo).toBe(false);
	});
});

describe('onMetamodelRebound', () => {
	it('drops the undo history a landed rebind invalidated', async () => {
		vi.spyOn(mmApi, 'getMetamodelLayout').mockResolvedValue({
			positions: { 'el:Zone': { x: 1, y: 1 } }
		});
		await initMetamodelDiagram('p1');
		moveNode('el:Zone', { x: 1, y: 2 });
		expect(applyDiagramEdit({ kind: 'renameElementType', from: 'Zone', to: 'District' })).toBe(
			true
		);
		expect(getMetamodelDiagramView().canUndo).toBe(true);

		onMetamodelRebound();

		expect(getMetamodelDiagramView().canUndo).toBe(false);
		undoDiagramEdit();
		expect(getMetamodelDiagramView().positions['el:District']).toEqual({ x: 1, y: 2 });
		expect(editorState.buffer).toContain('- name: District');
	});
});

describe('lint-error attribution', () => {
	/**
	 * `POST /metamodel/lint` attaches a `line` ONLY to a YAML syntax error;
	 * every schema error is message-only (`api/schemas.py` `LintErrorOut`). So
	 * the realistic error class can never be pinned to a node, and the toolbar
	 * count is the surface that must always be right.
	 */
	it('counts a message-only (schema) error toward the toolbar, badging nothing', () => {
		editorState.lintErrors = [{ message: "unknown extends 'Nope'", line: null, column: null }];

		const v = getMetamodelDiagramView();

		expect(v.errorNodeIds.size).toBe(0);
		expect(v.unattributedErrorCount).toBe(1);
	});

	it('ignores a line-bearing error while the buffer parses — it is provably stale', () => {
		// `_lintErrors` is not cleared on keystroke, so right after a syntax
		// error is fixed the old line-bearing error is still in the array. Its
		// line lands squarely inside Zone's block, so pre-guard this badged
		// `el:Zone`; a locally clean parse proves no such error exists now.
		const range = lineRangeForType(FIXTURE, parseDraft(FIXTURE).doc, 'elements', 'Zone');
		expect(range).not.toBeNull();
		editorState.lintErrors = [
			{ message: 'mapping values are not allowed here', line: range!.start, column: 1 }
		];

		const v = getMetamodelDiagramView();

		expect(v.parseErrors).toEqual([]);
		expect([...v.errorNodeIds]).toEqual([]);
		expect(v.unattributedErrorCount).toBe(1);
	});

	it('still counts errors when the buffer does not parse and nothing is drawn', () => {
		editorState.buffer = 'elements: [\n';
		editorState.lintErrors = [
			{ message: 'flow sequence not terminated', line: 1, column: 11 },
			{ message: 'something else', line: null, column: null }
		];

		const v = getMetamodelDiagramView();

		expect(v.mm).toBeNull();
		expect(v.errorNodeIds.size).toBe(0);
		expect(v.unattributedErrorCount).toBe(2);
	});
});

describe('viewers', () => {
	it('arrange and drag locally but stage nothing', async () => {
		setProjectInfo({ role: 'viewer', lockTtlSeconds: 300 });
		vi.spyOn(mmApi, 'getMetamodelLayout').mockResolvedValue({ positions: {} });

		await initMetamodelDiagram('p1');

		expect(Object.keys(getMetamodelDiagramView().positions).length).toBeGreaterThan(0);
		expect(getStagedMetamodelOps()).toEqual([]);

		moveNode('el:Zone', { x: 1, y: 2 });
		expect(getMetamodelDiagramView().positions['el:Zone']).toEqual({ x: 1, y: 2 });
		expect(getStagedMetamodelOps()).toEqual([]);

		await runAutoArrange();
		expect(getStagedMetamodelOps()).toEqual([]);
	});
});
