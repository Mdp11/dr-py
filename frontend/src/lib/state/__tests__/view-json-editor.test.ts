import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as viewsApi from '$lib/api/views';
import { ConflictError } from '$lib/api/errors';
import type { View } from '$lib/api/types';
import * as viewStore from '../view.svelte';
import * as viewEdits from '../view-edits.svelte';
import {
	closeViewJsonEditor,
	discardViewJsonDraft,
	editViewJsonBuffer,
	getViewJsonEditor,
	initViewJsonEditor,
	noteViewJsonServerChanged,
	parseViewJson,
	pretty,
	resetViewJsonEditor,
	saveViewJson,
	VIEW_JSON_PARSE_DEBOUNCE_MS
} from '../view-json-editor.svelte';

const doc = (name = 'Ops'): View => ({
	name,
	folders: [{ id: 'f1', name: 'F', folders: [], elements: ['e1'], artifacts: [] }],
	artifacts: []
});

function mockGet(view: View, rev: number) {
	return vi.spyOn(viewsApi, 'getView').mockResolvedValue({ view, warnings: [], view_rev: rev });
}

async function flush(): Promise<void> {
	for (let i = 0; i < 6; i++) await Promise.resolve();
}

beforeEach(() => {
	resetViewJsonEditor();
	localStorage.clear();
	vi.spyOn(viewStore, 'adoptSavedView').mockResolvedValue();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	resetViewJsonEditor();
});

describe('parseViewJson', () => {
	it('accepts an object and anchors a syntax error to a line', () => {
		expect(parseViewJson('{"name":"x"}')).toEqual({ ok: true, doc: { name: 'x' } });
		const bad = parseViewJson('{\n  nope');
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect([bad.error.line, bad.error.column]).toEqual([2, 3]);
		const arr = parseViewJson('[]');
		expect(arr.ok).toBe(false);
	});
});

describe('view JSON editor', () => {
	it('loads the view pretty-printed and is clean', async () => {
		mockGet(doc(), 2);
		await initViewJsonEditor('p1', 'v1');
		const ed = getViewJsonEditor();
		expect(ed.phase).toBe('ready');
		expect(ed.buffer).toBe(pretty(doc()));
		expect(ed.dirty).toBe(false);
	});

	it('saves with the base rev, adopts the canonical document and refreshes the displayed view', async () => {
		mockGet(doc(), 2);
		await initViewJsonEditor('p1', 'v1');
		const edited = doc('Renamed');
		editViewJsonBuffer(pretty(edited));
		expect(getViewJsonEditor().dirty).toBe(true);

		const put = vi
			.spyOn(viewsApi, 'updateView')
			.mockResolvedValue({ id: 'v1', name: 'Renamed', view_rev: 3 });
		mockGet(edited, 3);
		expect(await saveViewJson()).toBe(true);

		expect(put).toHaveBeenCalledWith('v1', { view: edited, base_view_rev: 2 });
		expect(viewStore.adoptSavedView).toHaveBeenCalledWith('v1');
		expect(getViewJsonEditor().dirty).toBe(false);
		expect(localStorage.getItem('ui.view.draft.p1.v1')).toBeNull();
	});

	it('refuses to save invalid JSON or over staged folder edits to the same view', async () => {
		mockGet(doc(), 0);
		await initViewJsonEditor('p1', 'v1');
		const put = vi.spyOn(viewsApi, 'updateView');

		editViewJsonBuffer('{ nope');
		expect(await saveViewJson()).toBe(false);
		expect(getViewJsonEditor().parseErrors).toHaveLength(1);

		editViewJsonBuffer(pretty(doc('X')));
		vi.spyOn(viewEdits, 'getStagedViewOps').mockReturnValue([
			{ kind: 'rename_folder', view_id: 'v1', id: 'f1', name: 'G' }
		]);
		expect(await saveViewJson()).toBe(false);
		expect(getViewJsonEditor().saveError).toMatch(/staged folder changes/);
		expect(put).not.toHaveBeenCalled();
	});

	it('a 409 surfaces the message and flags stale when the rev moved', async () => {
		mockGet(doc(), 0);
		await initViewJsonEditor('p1', 'v1');
		editViewJsonBuffer(pretty(doc('X')));
		vi.spyOn(viewsApi, 'updateView').mockRejectedValue(
			new ConflictError(409, {}, 'view changed since it was loaded (now at rev 1)')
		);
		mockGet(doc(), 1);
		expect(await saveViewJson()).toBe(false);
		await flush();
		const ed = getViewJsonEditor();
		expect(ed.saveError).toMatch(/changed since/);
		expect(ed.stale).toBe(true);
		expect(ed.dirty).toBe(true);
	});

	it('a server change adopts in place when clean and flags stale when dirty', async () => {
		mockGet(doc(), 0);
		await initViewJsonEditor('p1', 'v1');
		mockGet(doc('Peer'), 1);
		noteViewJsonServerChanged('v1');
		await flush();
		expect(getViewJsonEditor().buffer).toBe(pretty(doc('Peer')));
		expect(getViewJsonEditor().phase).toBe('ready');

		editViewJsonBuffer(pretty(doc('Mine')));
		mockGet(doc('Peer2'), 2);
		noteViewJsonServerChanged(null);
		await flush();
		expect(getViewJsonEditor().stale).toBe(true);
		expect(getViewJsonEditor().buffer).toBe(pretty(doc('Mine')));
	});

	it('persists a dirty draft across close and restores it; discard drops it', async () => {
		vi.useFakeTimers();
		mockGet(doc(), 0);
		await initViewJsonEditor('p1', 'v1');
		editViewJsonBuffer(pretty(doc('Draft')));
		vi.advanceTimersByTime(VIEW_JSON_PARSE_DEBOUNCE_MS);
		closeViewJsonEditor();
		expect(localStorage.getItem('ui.view.draft.p1.v1')).toBe(pretty(doc('Draft')));

		await initViewJsonEditor('p1', 'v1');
		expect(getViewJsonEditor().draftRestored).toBe(true);
		expect(getViewJsonEditor().buffer).toBe(pretty(doc('Draft')));

		await discardViewJsonDraft();
		expect(getViewJsonEditor().buffer).toBe(pretty(doc()));
		expect(localStorage.getItem('ui.view.draft.p1.v1')).toBeNull();
	});
});
