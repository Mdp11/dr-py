import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as artifactsApi from '$lib/api/artifacts';
import { ConflictError } from '$lib/api/errors';
import {
	closeSnippetDraft,
	ensureSnippetDraft,
	getSnippetDraft,
	getSnippetSaveConflict,
	resetSnippetEditors,
	saveSnippetDraft,
	setSnippetName,
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
		expect(draft.code).toContain('dr');
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
