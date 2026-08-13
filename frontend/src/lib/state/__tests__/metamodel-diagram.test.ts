import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as mmApi from '$lib/api/metamodel';
import { FIXTURE } from '$lib/metamodel/__tests__/fixtures';
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
	lintErrors: [] as { message: string; line: number | null; column: number | null }[]
}));

vi.mock('../metamodel-editor.svelte', () => ({
	getMetamodelEditor: () => ({
		buffer: editorState.buffer,
		readOnly: editorState.readOnly,
		lintErrors: editorState.lintErrors
	}),
	editMetamodelBuffer: (code: string) => {
		// Mirrors the real module's `isEditBlocked()` early return, so a test
		// that flips `readOnly` proves the diagram module refused rather than
		// that the stub happened to keep the buffer.
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
		expect(editorState.buffer).toBe(FIXTURE);
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
		vi.useFakeTimers();
		const put = vi.spyOn(mmApi, 'putMetamodelLayout').mockResolvedValue(undefined);
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
