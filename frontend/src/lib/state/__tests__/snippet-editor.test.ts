import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as artifactsApi from '$lib/api/artifacts';
import * as snippetsApi from '$lib/api/snippets';
import { ApiError, ConflictError } from '$lib/api/errors';
import {
	addSnippetElement,
	clearSnippetElements,
	closeSnippetDraft,
	ensureSnippetDraft,
	getSnippetDraft,
	getSnippetLint,
	getSnippetRun,
	getSnippetSaveConflict,
	hasDirtySnippetDrafts,
	LINT_DEBOUNCE_MS,
	markRunStaged,
	removeSnippetElement,
	resetSnippetEditors,
	runSnippetTab,
	saveSnippetDraft,
	setSnippetEntry,
	setSnippetName,
	stopSnippetTab,
	updateSnippetCode
} from '../snippet-editor.svelte';
import { getDynamicTabs, openArtifactTab, resetWorkspaceTabs } from '../workspace.svelte';
import { resetArtifacts } from '../artifacts.svelte';

const SNIPPET_ARTIFACT = {
	id: 's1',
	kind: 'code_snippet',
	name: 'My snippet',
	artifact_rev: 3,
	updated_at: '2026-07-17T00:00:00Z',
	updated_by: 'u1',
	entry_points: ['script', 'value'],
	payload: {
		schema_version: 1,
		language: 'python',
		code: 'print(1)\n',
		entry_points: ['script', 'value']
	}
};

beforeEach(() => {
	vi.spyOn(artifactsApi, 'listArtifacts').mockResolvedValue({ items: [] });
});
afterEach(() => {
	resetSnippetEditors();
	resetWorkspaceTabs();
	resetArtifacts();
	vi.restoreAllMocks();
});

describe('snippet drafts', () => {
	it('creates a fresh draft for a snip:draft:* tab', async () => {
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		expect(tabId).toMatch(/^snip:draft:/);
		const draft = await ensureSnippetDraft(tabId);
		expect(draft.artifactId).toBeNull();
		expect(draft.dirty).toBe(false);
		expect(draft.code).toBe('');
	});

	it('a fresh never-saved draft does not count as dirty until edited', async () => {
		const tabId = 'snip:draft:9';
		await ensureSnippetDraft(tabId);
		expect(hasDirtySnippetDrafts()).toBe(false);
		updateSnippetCode(tabId, 'print(1)\n');
		expect(hasDirtySnippetDrafts()).toBe(true);
	});

	it('loads a saved artifact draft and adopts server entry points', async () => {
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(SNIPPET_ARTIFACT);
		const tabId = openArtifactTab('snippet', { artifactId: 's1', title: 'My snippet' });
		const draft = await ensureSnippetDraft(tabId);
		expect(draft.code).toBe('print(1)\n');
		expect(draft.artifactRev).toBe(3);
		expect(draft.entryPoints).toEqual(['script', 'value']);
	});

	it('marks dirty on edit and clean after save; first save rebinds the tab', async () => {
		const create = vi.spyOn(artifactsApi, 'createArtifact').mockResolvedValue(SNIPPET_ARTIFACT);
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		updateSnippetCode(tabId, 'print(2)\n');
		setSnippetName(tabId, 'My snippet');
		expect(getSnippetDraft(tabId)?.dirty).toBe(true);
		await saveSnippetDraft(tabId);
		expect(create).toHaveBeenCalledWith({
			kind: 'code_snippet',
			name: 'My snippet',
			payload: { schema_version: 1, language: 'python', code: 'print(2)\n' }
		});
		expect(getSnippetDraft(tabId)).toBeUndefined(); // moved to snip:s1
		const moved = getSnippetDraft('snip:s1');
		expect(moved?.dirty).toBe(false);
		expect(moved?.artifactId).toBe('s1');
		expect(getDynamicTabs().find((t) => t.id === 'snip:s1')).toBeDefined();
	});

	it('records a rev conflict on 409 with current_rev and clears it on reload', async () => {
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue(SNIPPET_ARTIFACT);
		vi.spyOn(artifactsApi, 'updateArtifact').mockRejectedValue(
			new ConflictError(409, { detail: { message: 'stale', current_rev: 9 } }, 'stale')
		);
		const tabId = openArtifactTab('snippet', { artifactId: 's1', title: 'My snippet' });
		await ensureSnippetDraft(tabId);
		updateSnippetCode(tabId, 'print(3)\n');
		await expect(saveSnippetDraft(tabId)).rejects.toThrow();
		expect(getSnippetSaveConflict(tabId)).toBe(9);
	});

	it('close drops the draft', async () => {
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		closeSnippetDraft(tabId);
		expect(getSnippetDraft(tabId)).toBeUndefined();
	});
});

const RUN_OUT = {
	run_id: 'r-1',
	stdout: 'hello\n',
	result_repr: null,
	ops: [],
	error: null,
	duration_ms: 5,
	model_rev: 0,
	stale: false,
	truncated: false
};

describe('snippet lint + run', () => {
	it('debounces lint and applies the latest response', async () => {
		vi.useFakeTimers();
		const lint = vi.spyOn(snippetsApi, 'lintSnippet').mockResolvedValue({
			diagnostics: [{ line: 1, col: 0, severity: 'warning', message: 'w' }],
			entry_points: ['script']
		});
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		lint.mockClear(); // drop the open-time immediate lint
		updateSnippetCode(tabId, 'import os\n');
		updateSnippetCode(tabId, 'import os  #\n');
		await vi.advanceTimersByTimeAsync(LINT_DEBOUNCE_MS + 10);
		expect(lint).toHaveBeenCalledTimes(1);
		expect(lint).toHaveBeenCalledWith('import os  #\n');
		expect(getSnippetLint(tabId)?.diagnostics).toHaveLength(1);
		vi.useRealTimers();
	});

	it('runs and installs the result', async () => {
		vi.spyOn(snippetsApi, 'runSnippet').mockResolvedValue(RUN_OUT);
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		updateSnippetCode(tabId, 'print("hello")\n');
		await runSnippetTab(tabId);
		const rs = getSnippetRun(tabId);
		expect(rs.phase).toBe('idle');
		expect(rs.result?.stdout).toBe('hello\n');
	});

	it('sends entry + element_ids (bound order, deduped) for a value run', async () => {
		// runSnippetTab refuses to send an entry lint hasn't unlocked (see the
		// entryAvailable guard), so 'value' must be in the lint response —
		// drive that via the debounced lint (fake timers), not the fire-and-
		// forget immediate lint ensureSnippetDraft kicks off.
		vi.useFakeTimers();
		vi.spyOn(snippetsApi, 'lintSnippet').mockResolvedValue({
			diagnostics: [],
			entry_points: ['script', 'value']
		});
		const run = vi.spyOn(snippetsApi, 'runSnippet').mockResolvedValue(RUN_OUT);
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		updateSnippetCode(tabId, 'def value(elements):\n    return len(elements)\n');
		await vi.advanceTimersByTimeAsync(LINT_DEBOUNCE_MS + 10);
		setSnippetEntry(tabId, 'value');
		addSnippetElement(tabId, 'e2', 'Building e2');
		addSnippetElement(tabId, 'e1', 'Building e1');
		addSnippetElement(tabId, 'e2', 'Building e2'); // duplicate — ignored
		await runSnippetTab(tabId);
		expect(run.mock.calls[0][0]).toMatchObject({ entry: 'value', element_ids: ['e2', 'e1'] });
		vi.useRealTimers();
	});

	it('element binding: remove, clear, step-mode replace and truncate-on-switch', () => {
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		setSnippetEntry(tabId, 'value');
		addSnippetElement(tabId, 'e1', 'One');
		addSnippetElement(tabId, 'e2', 'Two');
		addSnippetElement(tabId, 'e3', 'Three');
		removeSnippetElement(tabId, 'e2');
		expect(getSnippetRun(tabId).elements.map((e) => e.id)).toEqual(['e1', 'e3']);
		// switching to step keeps only the first chip (single-element contract)
		setSnippetEntry(tabId, 'step');
		expect(getSnippetRun(tabId).elements.map((e) => e.id)).toEqual(['e1']);
		// step: picking replaces instead of appending
		addSnippetElement(tabId, 'e9', 'Nine');
		expect(getSnippetRun(tabId).elements.map((e) => e.id)).toEqual(['e9']);
		clearSnippetElements(tabId);
		expect(getSnippetRun(tabId).elements).toEqual([]);
	});

	it('refuses to run a value entry with no bound elements', async () => {
		const run = vi.spyOn(snippetsApi, 'runSnippet').mockResolvedValue(RUN_OUT);
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		setSnippetEntry(tabId, 'value');
		await runSnippetTab(tabId);
		expect(run).not.toHaveBeenCalled();
	});

	it('stop discards the eventual response', async () => {
		let resolveRun!: (v: typeof RUN_OUT) => void;
		vi.spyOn(snippetsApi, 'runSnippet').mockReturnValue(new Promise((r) => (resolveRun = r)));
		vi.spyOn(snippetsApi, 'cancelSnippet').mockResolvedValue(undefined);
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		const running = runSnippetTab(tabId);
		expect(getSnippetRun(tabId).phase).toBe('running');
		await stopSnippetTab(tabId);
		expect(getSnippetRun(tabId).phase).toBe('idle');
		expect(getSnippetRun(tabId).notice).toContain('wall timeout');
		resolveRun(RUN_OUT);
		await running;
		expect(getSnippetRun(tabId).result).toBeNull(); // discarded
	});

	it('maps 429 and 503 to notices', async () => {
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		vi.spyOn(snippetsApi, 'runSnippet').mockRejectedValue(new ApiError(429, null, 'busy'));
		await runSnippetTab(tabId);
		expect(getSnippetRun(tabId).notice).toContain('already in progress');
		vi.spyOn(snippetsApi, 'runSnippet').mockRejectedValue(new ApiError(503, null, 'no runner'));
		await runSnippetTab(tabId);
		expect(getSnippetRun(tabId).notice).toContain('unavailable');
	});

	it('leaves the entry selected even when a new lint drops it — the hint bar needs it', async () => {
		// Superseded contract (was "resets a stale entry to script..."): the
		// select is always selectable now (SnippetTab hint bar + insert-stub),
		// so a lint response that doesn't (yet) include the chosen entry must
		// NOT yank the selection back to 'script' out from under the user
		// while they're still writing def value(el)/step(el). The stale-send
		// guarantee this reset used to provide now lives in runSnippetTab.
		vi.useFakeTimers();
		const lint = vi.spyOn(snippetsApi, 'lintSnippet').mockResolvedValue({
			diagnostics: [],
			entry_points: ['script', 'value']
		});
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		setSnippetEntry(tabId, 'value');
		expect(getSnippetRun(tabId).entry).toBe('value');

		lint.mockResolvedValue({ diagnostics: [], entry_points: ['script'] }); // 'value' dropped
		updateSnippetCode(tabId, 'print(1)\n');
		await vi.advanceTimersByTimeAsync(LINT_DEBOUNCE_MS + 10);
		expect(getSnippetRun(tabId).entry).toBe('value'); // NOT reset to 'script'
		vi.useRealTimers();
	});

	it('leaves the entry untouched when the new lint still contains it', async () => {
		vi.useFakeTimers();
		const lint = vi.spyOn(snippetsApi, 'lintSnippet').mockResolvedValue({
			diagnostics: [],
			entry_points: ['script', 'value']
		});
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		setSnippetEntry(tabId, 'value');

		lint.mockResolvedValue({ diagnostics: [], entry_points: ['script', 'value'] });
		updateSnippetCode(tabId, 'print(1)\n');
		await vi.advanceTimersByTimeAsync(LINT_DEBOUNCE_MS + 10);
		expect(getSnippetRun(tabId).entry).toBe('value');
		vi.useRealTimers();
	});

	it('runSnippetTab is a no-op when the selected entry is not (yet) lint-available', async () => {
		// The stale-send guarantee moved here from lintNow's old auto-reset:
		// Mod-Enter (CodeEditor keymap) calls runSnippetTab directly, bypassing
		// the disabled Run button, so the store itself must refuse to send.
		const run = vi.spyOn(snippetsApi, 'runSnippet').mockResolvedValue(RUN_OUT);
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId); // immediate lint -> entry_points: [] (empty draft)
		setSnippetEntry(tabId, 'value');
		addSnippetElement(tabId, 'e1', 'Building e1');

		await runSnippetTab(tabId);

		expect(run).not.toHaveBeenCalled();
		expect(getSnippetRun(tabId).phase).toBe('idle');
	});

	it('runSnippetTab sends once the lint response includes the selected entry', async () => {
		vi.useFakeTimers();
		const lint = vi.spyOn(snippetsApi, 'lintSnippet').mockResolvedValue({
			diagnostics: [],
			entry_points: ['script']
		});
		const run = vi.spyOn(snippetsApi, 'runSnippet').mockResolvedValue(RUN_OUT);
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		setSnippetEntry(tabId, 'value');
		addSnippetElement(tabId, 'e1', 'Building e1');

		lint.mockResolvedValue({ diagnostics: [], entry_points: ['script', 'value'] });
		updateSnippetCode(tabId, 'def value(el):\n    return el.name\n');
		await vi.advanceTimersByTimeAsync(LINT_DEBOUNCE_MS + 10);

		await runSnippetTab(tabId);

		expect(run).toHaveBeenCalledTimes(1);
		expect(getSnippetRun(tabId).phase).toBe('idle');
		vi.useRealTimers();
	});

	it('markRunStaged pins the staged run id', async () => {
		vi.spyOn(snippetsApi, 'runSnippet').mockResolvedValue(RUN_OUT);
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		await runSnippetTab(tabId);
		markRunStaged(tabId);
		expect(getSnippetRun(tabId).stagedRunId).toBe('r-1');
	});

	it('rekey on first save normalizes an in-flight run to idle with a discard notice', async () => {
		vi.spyOn(artifactsApi, 'createArtifact').mockResolvedValue(SNIPPET_ARTIFACT);
		let resolveRun!: (v: typeof RUN_OUT) => void;
		vi.spyOn(snippetsApi, 'runSnippet').mockReturnValue(new Promise((r) => (resolveRun = r)));
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		const running = runSnippetTab(tabId);
		expect(getSnippetRun(tabId).phase).toBe('running');
		await saveSnippetDraft(tabId); // first save rekeys tabId -> snip:s1 mid-run
		const newTab = `snip:${SNIPPET_ARTIFACT.id}`;
		expect(getSnippetRun(newTab)).toMatchObject({
			phase: 'idle',
			runId: null,
			notice: expect.stringContaining('discarded')
		});
		resolveRun(RUN_OUT); // the orphaned response must never land anywhere
		await running;
		expect(getSnippetRun(newTab).result).toBeNull();
		expect(getSnippetRun(tabId).result).toBeNull();
	});

	it('stop drops its post-cancel write if the draft closed mid-cancel', async () => {
		vi.spyOn(snippetsApi, 'runSnippet').mockReturnValue(new Promise(() => {})); // never resolves
		let resolveCancel!: () => void;
		vi.spyOn(snippetsApi, 'cancelSnippet').mockReturnValue(new Promise((r) => (resolveCancel = r)));
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		void runSnippetTab(tabId);
		expect(getSnippetRun(tabId).phase).toBe('running');
		const stopping = stopSnippetTab(tabId);
		closeSnippetDraft(tabId); // draft (and its _runs entry) gone before cancel settles
		resolveCancel();
		await stopping;
		expect(getSnippetRun(tabId)).toEqual({
			phase: 'idle',
			runId: null,
			result: null,
			stagedRunId: null,
			notice: null,
			entry: 'script',
			elements: []
		});
	});
});
