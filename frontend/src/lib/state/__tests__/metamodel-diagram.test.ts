import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as mmApi from '$lib/api/metamodel';
import { FIXTURE } from '$lib/metamodel/__tests__/fixtures';
import { lineRangeForType, parseDraft } from '$lib/metamodel/yaml-edit';
import { resetCheckout, setProjectInfo } from '../checkout.svelte';
import {
	applyDiagramEdit,
	closeMetamodelDiagram,
	getMetamodelDiagramView,
	initMetamodelDiagram,
	LAYOUT_SAVE_DEBOUNCE_MS,
	moveNode,
	onMetamodelRebound,
	undoDiagramEdit
} from '../metamodel-diagram.svelte';

/**
 * The diagram half of the metamodel tab (Task 9). This module owns NO draft
 * state: it parses the editor module's buffer, applies one semantic YAML
 * command, and writes the text back through `editMetamodelBuffer`. So the
 * editor module is MOCKED down to the two functions that seam touches — a
 * tiny in-test buffer store — which keeps these tests about the diagram
 * module's own behaviour (commands, undo, shared layout, rename deferral)
 * rather than about the lease/lint/draft lifecycle that already has its own
 * suite (`metamodel-editor.test.ts`).
 *
 * The layout API is spied rather than whole-module mocked (the precedent in
 * `metamodel-editor.test.ts`): nothing reaches the network, and the real
 * `getRole()` from `checkout.svelte` decides who may save.
 */

const editorState = vi.hoisted(() => ({
	buffer: '',
	readOnly: false,
	/** The real module's load phase. `'error'` (with an EMPTY buffer) is the
	 * shape a failed metamodel load leaves behind, and `MetamodelTab.init()`
	 * calls `initMetamodelDiagram` in it regardless — see the
	 * "metamodel that failed to load" block below. */
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
		lintErrors: editorState.lintErrors
	}),
	editMetamodelBuffer: (code: string) => {
		editorState.writes++;
		// Mirrors the real module's `isEditBlocked()` early return, so the stub
		// cannot accept a write the real editor would drop.
		if (editorState.readOnly) return;
		editorState.buffer = code;
	}
}));

beforeEach(() => {
	localStorage.clear();
	resetCheckout();
	setProjectInfo({ role: 'owner', lockTtlSeconds: 300 });
	editorState.buffer = FIXTURE;
	editorState.readOnly = false;
	editorState.phase = 'ready';
	editorState.writes = 0;
	editorState.lintErrors = [];
});

afterEach(() => {
	// Reset BEFORE restoring the spies: close flushes a pending layout PUT, and
	// that flush must land on the mock, never on the real client.
	closeMetamodelDiagram();
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
});

describe('undoDiagramEdit read-only guard', () => {
	/**
	 * `applyDiagramEdit` guards on `readOnly`; the undo has to as well, and for
	 * a sharper reason than symmetry. It rolls back `_positions` and
	 * `_pendingRenames` unconditionally, but the buffer half goes through
	 * `editMetamodelBuffer`, which SILENTLY DROPS the write when the editor is
	 * blocked. Reachable: the `mm` lease is acquired asynchronously on the first
	 * divergent edit, so a rename can land and only then lose the race to a
	 * peer's lease.
	 */
	it('refuses while the surface is read-only, so the keys cannot desync from the draft', async () => {
		vi.useFakeTimers();
		const put = vi.spyOn(mmApi, 'putMetamodelLayout').mockResolvedValue(undefined);
		moveNode('el:Zone', { x: 5, y: 6 });
		expect(applyDiagramEdit({ kind: 'renameElementType', from: 'Zone', to: 'District' })).toBe(
			true
		);
		await vi.advanceTimersByTimeAsync(LAYOUT_SAVE_DEBOUNCE_MS);
		put.mockClear();
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

		await vi.advanceTimersByTimeAsync(LAYOUT_SAVE_DEBOUNCE_MS * 2);
		// Without the guard this PUTs `el:Zone` — a rolled-back deferral against
		// a draft that kept the rename.
		expect(put).not.toHaveBeenCalled();
	});
});

describe('a metamodel that failed to load', () => {
	const DISTRICT_DRAFT = FIXTURE.replaceAll('Zone', 'District');

	/**
	 * `MetamodelTab.init()` awaits `initMetamodelEditor` and then calls
	 * `initMetamodelDiagram` UNCONDITIONALLY, including when the load failed and
	 * left `phase: 'error'` with an empty buffer. An empty buffer parses cleanly
	 * into an empty metamodel, so a naive liveness check reads it as "the draft
	 * defines nothing" and prunes the whole deferral map — permanently, since
	 * `restoreRenames` writes the pruned map straight back.
	 */
	it('keeps the persisted rename map instead of pruning it against an empty buffer', async () => {
		const stored = JSON.stringify([['el:Zone', 'el:District']]);
		localStorage.setItem('ui.metamodel.renames.p1', stored);
		editorState.phase = 'error';
		editorState.buffer = '';
		const put = vi.spyOn(mmApi, 'putMetamodelLayout').mockResolvedValue(undefined);
		vi.spyOn(mmApi, 'getMetamodelLayout').mockResolvedValue({
			positions: { 'el:Zone': { x: 3, y: 4 } }
		});

		await initMetamodelDiagram('p1');

		expect(localStorage.getItem('ui.metamodel.renames.p1')).toBe(stored);

		// The user hits Retry and the draft comes back saying District.
		editorState.phase = 'ready';
		editorState.buffer = DISTRICT_DRAFT;

		vi.useFakeTimers();
		moveNode('el:District', { x: 9, y: 9 });
		await vi.advanceTimersByTimeAsync(LAYOUT_SAVE_DEBOUNCE_MS);

		// Still the baseline key space. Without the guard the map is gone, and
		// this PUT writes the draft-local `el:District` into the SHARED blob.
		expect(put).toHaveBeenCalledTimes(1);
		const sent = put.mock.calls[0][0].positions;
		expect(sent['el:Zone']).toEqual({ x: 9, y: 9 });
		expect(sent['el:District']).toBeUndefined();
	});
});

describe('a failed layout GET', () => {
	/**
	 * "No stored layout" is NOT an error: `routes/metamodel_layout.py` answers
	 * 200 with `{positions: {}}`. So the catch path is a genuine failure, where
	 * the client cannot tell an unarranged project from an unreadable one — and
	 * a PUT there replaces the ENTIRE shared blob for every member.
	 */
	/** REAL timers throughout, deliberately: elkjs runs during init, and the
	 * bug being pinned is a save SCHEDULED there. Swapping to fake timers after
	 * the init would leave that real timer pending and un-advanceable, so the
	 * "no PUT" assertion would pass whether or not the fix is present. */
	const settleDebounce = (): Promise<void> =>
		new Promise((resolve) => setTimeout(resolve, LAYOUT_SAVE_DEBOUNCE_MS + 50));

	it('arranges locally but persists nothing, so no peer position is overwritten', async () => {
		const put = vi.spyOn(mmApi, 'putMetamodelLayout').mockResolvedValue(undefined);
		vi.spyOn(mmApi, 'getMetamodelLayout').mockRejectedValue(new Error('boom'));

		await initMetamodelDiagram('p1');
		await settleDebounce();

		expect(put).not.toHaveBeenCalled();

		// The arrange itself still happened — a local canvas beats stacking every
		// box at the origin. Proven by what a later DELIBERATE drag sends: the
		// whole arranged blob, not just the dragged node. (That drag persisting
		// is the accepted residual — a user gesture re-establishes intent.)
		moveNode('el:Zone', { x: 1, y: 1 });
		await settleDebounce();
		expect(put).toHaveBeenCalledTimes(1);
		expect(Object.keys(put.mock.calls[0][0].positions).length).toBeGreaterThan(1);
	});

	it('does persist the first arrangement when the GET answered with an empty blob', async () => {
		const put = vi.spyOn(mmApi, 'putMetamodelLayout').mockResolvedValue(undefined);
		vi.spyOn(mmApi, 'getMetamodelLayout').mockResolvedValue({ positions: {} });

		await initMetamodelDiagram('p1');
		await settleDebounce();

		expect(put).toHaveBeenCalledTimes(1);
	});
});

describe('moveNode', () => {
	it('moves the node immediately and PUTs the layout once the debounce elapses', async () => {
		vi.useFakeTimers();
		const put = vi.spyOn(mmApi, 'putMetamodelLayout').mockResolvedValue(undefined);

		moveNode('el:Zone', { x: 10, y: 20 });

		expect(getMetamodelDiagramView().positions['el:Zone']).toEqual({ x: 10, y: 20 });
		expect(put).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(LAYOUT_SAVE_DEBOUNCE_MS);

		expect(put).toHaveBeenCalledTimes(1);
		expect(put.mock.calls[0][0].positions['el:Zone']).toEqual({ x: 10, y: 20 });
	});
});

describe('rename key-deferral', () => {
	it('moves the local position key at once but keeps PUTting the baseline key until rebind', async () => {
		const put = vi.spyOn(mmApi, 'putMetamodelLayout').mockResolvedValue(undefined);
		// `onMetamodelRebound` is project-guarded like every other entry point,
		// so the surface has to be open. A NON-EMPTY stored blob makes the init
		// return before the auto-arrange, so no elk run and no pending timer.
		vi.spyOn(mmApi, 'getMetamodelLayout').mockResolvedValue({
			positions: { 'el:Zone': { x: 0, y: 0 } }
		});
		await initMetamodelDiagram('p1');

		vi.useFakeTimers();
		moveNode('el:Zone', { x: 5, y: 6 });
		await vi.advanceTimersByTimeAsync(LAYOUT_SAVE_DEBOUNCE_MS);
		put.mockClear();

		expect(applyDiagramEdit({ kind: 'renameElementType', from: 'Zone', to: 'District' })).toBe(
			true
		);

		// Local canvas follows the rename immediately (no jump to a fresh spot)...
		const v = getMetamodelDiagramView();
		expect(v.positions['el:District']).toEqual({ x: 5, y: 6 });
		expect(v.positions['el:Zone']).toBeUndefined();

		// ...but the SHARED blob is still keyed by the baseline name, because
		// peers render `Zone` until this draft is actually rebound.
		moveNode('el:District', { x: 7, y: 8 });
		await vi.advanceTimersByTimeAsync(LAYOUT_SAVE_DEBOUNCE_MS);
		expect(put).toHaveBeenCalledTimes(1);
		const deferred = put.mock.calls[0][0].positions;
		expect(deferred['el:Zone']).toEqual({ x: 7, y: 8 });
		expect(deferred['el:District']).toBeUndefined();

		// The rebind landed: the rename is now everyone's truth, so the key
		// rewrite goes out.
		put.mockClear();
		onMetamodelRebound();

		expect(put).toHaveBeenCalledTimes(1);
		const rebound = put.mock.calls[0][0].positions;
		expect(rebound['el:District']).toEqual({ x: 7, y: 8 });
		expect(rebound['el:Zone']).toBeUndefined();
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

describe('rebind clears the undo stack', () => {
	it('cannot undo across a landed rebind, so no dead key reaches the shared blob', async () => {
		const put = vi.spyOn(mmApi, 'putMetamodelLayout').mockResolvedValue(undefined);
		// Non-empty stored blob: opens the surface (so the project guard on
		// `onMetamodelRebound` passes) without triggering the auto-arrange.
		vi.spyOn(mmApi, 'getMetamodelLayout').mockResolvedValue({
			positions: { 'el:Zone': { x: 0, y: 0 } }
		});
		await initMetamodelDiagram('p1');

		vi.useFakeTimers();
		moveNode('el:Zone', { x: 1, y: 2 });
		await vi.advanceTimersByTimeAsync(LAYOUT_SAVE_DEBOUNCE_MS);
		expect(applyDiagramEdit({ kind: 'renameElementType', from: 'Zone', to: 'District' })).toBe(
			true
		);
		expect(getMetamodelDiagramView().canUndo).toBe(true);

		onMetamodelRebound();
		put.mockClear();

		// The undo entry snapshotted `{el:Zone}` + an empty rename map. Replaying
		// it after the rebind would PUT `el:Zone` — a name the server no longer
		// has — wiping every peer's `el:District` position.
		expect(getMetamodelDiagramView().canUndo).toBe(false);
		undoDiagramEdit();
		await vi.advanceTimersByTimeAsync(LAYOUT_SAVE_DEBOUNCE_MS * 2);

		expect(put).not.toHaveBeenCalled();
		expect(getMetamodelDiagramView().positions['el:District']).toEqual({ x: 1, y: 2 });
		expect(editorState.buffer).toContain('- name: District');
	});
});

describe('rename deferral across a page refresh', () => {
	const DISTRICT_DRAFT = FIXTURE.replaceAll('Zone', 'District');

	it('restores the persisted map, re-keys the fetched blob, and still PUTs the baseline key', async () => {
		// A previous session renamed Zone → District: the draft (restored by the
		// editor module) says District, the shared blob still says Zone.
		localStorage.setItem('ui.metamodel.renames.p1', JSON.stringify([['el:Zone', 'el:District']]));
		editorState.buffer = DISTRICT_DRAFT;
		const put = vi.spyOn(mmApi, 'putMetamodelLayout').mockResolvedValue(undefined);
		vi.spyOn(mmApi, 'getMetamodelLayout').mockResolvedValue({
			positions: { 'el:Zone': { x: 3, y: 4 } }
		});

		await initMetamodelDiagram('p1');

		// The box keeps its place instead of falling to a heuristic slot...
		expect(getMetamodelDiagramView().positions['el:District']).toEqual({ x: 3, y: 4 });

		vi.useFakeTimers();
		moveNode('el:District', { x: 9, y: 9 });
		await vi.advanceTimersByTimeAsync(LAYOUT_SAVE_DEBOUNCE_MS);

		// ...and the wire still speaks the baseline key space. Without the
		// restored map this PUT sends `el:District` (a draft-local key) and drops
		// `el:Zone` entirely, re-placing the box on every peer's canvas.
		expect(put).toHaveBeenCalledTimes(1);
		const sent = put.mock.calls[0][0].positions;
		expect(sent['el:Zone']).toEqual({ x: 9, y: 9 });
		expect(sent['el:District']).toBeUndefined();
	});

	it('drops a restored deferral the draft no longer backs (discarded rename)', async () => {
		// Same stored map, but the draft is back to the baseline — the shape a
		// `discardMetamodelDraft` leaves behind, which this module cannot observe.
		localStorage.setItem('ui.metamodel.renames.p1', JSON.stringify([['el:Zone', 'el:District']]));
		editorState.buffer = FIXTURE;
		const put = vi.spyOn(mmApi, 'putMetamodelLayout').mockResolvedValue(undefined);
		vi.spyOn(mmApi, 'getMetamodelLayout').mockResolvedValue({
			positions: { 'el:Zone': { x: 3, y: 4 } }
		});

		await initMetamodelDiagram('p1');

		expect(getMetamodelDiagramView().positions['el:Zone']).toEqual({ x: 3, y: 4 });
		// Pruned for good, not re-validated on every open.
		expect(localStorage.getItem('ui.metamodel.renames.p1')).toBeNull();

		vi.useFakeTimers();
		moveNode('el:Zone', { x: 1, y: 1 });
		await vi.advanceTimersByTimeAsync(LAYOUT_SAVE_DEBOUNCE_MS);

		expect(put.mock.calls[0][0].positions).toEqual({ 'el:Zone': { x: 1, y: 1 } });
	});

	it('lets the deferral win a baseline key the draft re-used', async () => {
		vi.useFakeTimers();
		const put = vi.spyOn(mmApi, 'putMetamodelLayout').mockResolvedValue(undefined);
		moveNode('el:Zone', { x: 1, y: 1 });
		applyDiagramEdit({ kind: 'renameElementType', from: 'Zone', to: 'District' });
		// The freed name is taken by a BRAND NEW type: two local keys now want
		// the single server key `el:Zone`.
		applyDiagramEdit({ kind: 'addElementType', name: 'Zone' });
		moveNode('el:Zone', { x: 2, y: 2 });

		await vi.advanceTimersByTimeAsync(LAYOUT_SAVE_DEBOUNCE_MS);

		// The deferral wins — it describes the box peers can actually see. The
		// re-used name has no server counterpart until a rebind lands. (Before
		// the injectivity guard the last `Object.entries` key won: {x:2,y:2}.)
		expect(put.mock.calls[0][0].positions['el:Zone']).toEqual({ x: 1, y: 1 });
	});
});

describe('viewers', () => {
	it('arranges and drags locally but never PUTs a layout', async () => {
		setProjectInfo({ role: 'viewer', lockTtlSeconds: 300 });
		const put = vi.spyOn(mmApi, 'putMetamodelLayout').mockResolvedValue(undefined);
		vi.spyOn(mmApi, 'getMetamodelLayout').mockResolvedValue({ positions: {} });

		// Real timers here: elkjs runs during init. Fake timers go in afterwards,
		// only to drive the save debounce that must never fire.
		await initMetamodelDiagram('p1');

		expect(Object.keys(getMetamodelDiagramView().positions).length).toBeGreaterThan(0);
		expect(put).not.toHaveBeenCalled();

		vi.useFakeTimers();
		moveNode('el:Zone', { x: 1, y: 2 });
		expect(getMetamodelDiagramView().positions['el:Zone']).toEqual({ x: 1, y: 2 });
		await vi.advanceTimersByTimeAsync(LAYOUT_SAVE_DEBOUNCE_MS * 2);

		expect(put).not.toHaveBeenCalled();
	});
});
