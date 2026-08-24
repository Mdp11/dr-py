import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as artifactsApi from '$lib/api/artifacts';
import * as rulesApi from '$lib/api/rules';
import * as snippetsApi from '$lib/api/snippets';
import * as tablesApi from '$lib/api/tables';
import {
	closeTableDraft,
	emit,
	ensureDraft,
	ensureEmbeddedDraft,
	ensureRulesDraft,
	ensureSnippetDraft,
	ensureTableDraft,
	editRulesDraft,
	hasDirtyNavDrafts,
	hasDirtyTableDrafts,
	resetModelStore,
	resetNavigationEditors,
	resetRulesEditors,
	resetSnippetEditors,
	resetTableEditors,
	seedElements,
	updateDefinition,
	updateSnippetCode,
	updateTableDefinition
} from '../index';
import { hasUnsavedWork, isArtifactDirty, isTabDirty } from '../unsaved';
import { openArtifactTab, resetWorkspaceTabs } from '../workspace.svelte';
import { resetArtifacts } from '../artifacts.svelte';
import { resetArtifactEdits, stageArtifactCreate } from '../artifact-edits.svelte';
import { resetViewEdits, stageViewOp } from '../view-edits.svelte';
import {
	clearStagedNodeMoves,
	initMetamodelStage,
	registerMetamodelDraftProvider,
	stageNodeMove
} from '../metamodel-stage.svelte';

const EMPTY_PAGE = {
	columns: [],
	rows: [],
	total: 0,
	truncated: false,
	offset: 0,
	model_rev: 1,
	warnings: []
};

beforeEach(() => {
	resetModelStore();
	resetTableEditors();
	resetNavigationEditors();
	resetSnippetEditors();
	resetRulesEditors();
	resetWorkspaceTabs();
	resetArtifacts();
	resetArtifactEdits();
	resetViewEdits();
	// Clear BEFORE re-opening the stage: `initMetamodelStage` restores whatever
	// the previous case left in the localStorage mirror.
	localStorage.clear();
	initMetamodelStage('p1');
	clearStagedNodeMoves();
	vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
	// ensureSnippetDraft()/updateSnippetCode() lint in the background; stub it so
	// the dirty-tracking assertions here don't escape to a real fetch.
	vi.spyOn(snippetsApi, 'lintSnippet').mockResolvedValue({
		diagnostics: [],
		entry_points: ['script']
	});
	// Same reason for the rules editor's own open-time lint.
	vi.spyOn(rulesApi, 'lintRules').mockResolvedValue({ ok: true, errors: [], warnings: [] });
});
afterEach(() => {
	resetNavigationEditors();
	resetSnippetEditors();
	resetRulesEditors();
	vi.restoreAllMocks();
});

describe('hasDirtyTableDrafts', () => {
	it('is false with no drafts and for a pristine draft', async () => {
		expect(hasDirtyTableDrafts()).toBe(false);
		await ensureTableDraft('tbl:draft:1');
		expect(hasDirtyTableDrafts()).toBe(false);
	});

	it('turns true on a definition edit and false when the draft closes', async () => {
		const draft = await ensureTableDraft('tbl:draft:1');
		updateTableDefinition('tbl:draft:1', draft.definition);
		expect(hasDirtyTableDrafts()).toBe(true);
		closeTableDraft('tbl:draft:1');
		expect(hasDirtyTableDrafts()).toBe(false);
	});
});

describe('hasDirtyNavDrafts', () => {
	it('turns true on a tab-draft edit', async () => {
		expect(hasDirtyNavDrafts()).toBe(false);
		const draft = await ensureDraft('nav:draft:1');
		expect(hasDirtyNavDrafts()).toBe(false);
		updateDefinition('nav:draft:1', draft.definition);
		expect(hasDirtyNavDrafts()).toBe(true);
	});

	it('ignores embedded drafts (their table owns the dirty flag)', () => {
		const draft = ensureEmbeddedDraft(
			'navemb:col:1',
			{
				kind: 'path',
				schema_version: 2,
				start: { kind: 'scope', types: [], criteria: [] },
				steps: [],
				exclude_visited: true
			},
			{ rowContext: false, rowElementId: null }
		);
		updateDefinition('navemb:col:1', draft.definition);
		expect(hasDirtyNavDrafts()).toBe(false);
	});
});

describe('hasUnsavedWork', () => {
	it('is false on a clean workspace', () => {
		expect(hasUnsavedWork()).toBe(false);
	});

	it('is true while ops are staged', () => {
		seedElements([{ id: 'e1', type_name: 'T', properties: { name: 'a' }, rev: 1 }]);
		emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'b' } });
		expect(hasUnsavedWork()).toBe(true);
	});

	it('is true with a dirty table draft only', async () => {
		const draft = await ensureTableDraft('tbl:draft:1');
		updateTableDefinition('tbl:draft:1', draft.definition);
		expect(hasUnsavedWork()).toBe(true);
	});

	it('is true with a dirty rules draft only', async () => {
		await ensureRulesDraft('rules:draft:1');
		expect(hasUnsavedWork()).toBe(false); // the starter comment is not work
		editRulesDraft('rules:draft:1', 'rules: []\n');
		expect(hasUnsavedWork()).toBe(true);
		expect(isTabDirty('rules', 'rules:draft:1')).toBe(true);
	});

	it('is true while only an artifact op is staged', () => {
		// A saved-but-uncommitted artifact leaves no dirty draft behind (the
		// editor's Save clears `dirty` and hands the work to the staged-artifact
		// buffer), so without the artifact-depth term the unload guard would let
		// the whole batch leave silently.
		stageArtifactCreate('navigation', 'N', {}, null);
		expect(hasUnsavedWork()).toBe(true);
	});

	it('is true for a staged VIEW op with no draft anywhere', () => {
		expect(hasUnsavedWork()).toBe(false);
		// A folder rename/move/placement goes straight from the gesture into the
		// view journal — there is no editor and therefore no draft to be dirty,
		// so without the view-depth term a view-ONLY batch would walk out of the
		// workspace past the unload guard while a model or artifact batch of the
		// same size is caught.
		stageViewOp({ kind: 'rename_folder', id: 'f1', name: 'Renamed' }, 'Renamed folder');
		expect(hasUnsavedWork()).toBe(true);

		resetViewEdits();
		expect(hasUnsavedWork()).toBe(false);
	});

	it('is true for a staged METAMODEL node move', () => {
		// Staged moves outlive the metamodel tab (they live in the stage module,
		// not behind the editor's provider), so a drag-then-close leaves work the
		// server has never seen with no draft anywhere to mark it — exactly the
		// hole the view term closes for folder gestures.
		expect(hasUnsavedWork()).toBe(false);
		stageNodeMove('el:Pump', { x: 1, y: 2 });
		expect(hasUnsavedWork()).toBe(true);

		clearStagedNodeMoves();
		expect(hasUnsavedWork()).toBe(false);
	});

	it('is true for a dirty metamodel YAML draft', () => {
		// The draft mirrors to localStorage, but so does every other staged
		// family's buffer now; the guard is what keeps leaving the workspace
		// consistent across all four.
		registerMetamodelDraftProvider(() => ({ dirty: true, blob: 'elements: []\n' }));
		expect(hasUnsavedWork()).toBe(true);
		registerMetamodelDraftProvider(() => ({ dirty: false, blob: '' }));
	});
});

describe('isTabDirty / isArtifactDirty', () => {
	it('a never-saved draft tab is dirty even before any edit', async () => {
		await ensureTableDraft('tbl:draft:1');
		expect(isTabDirty('table', 'tbl:draft:1')).toBe(true);
	});

	it('a tab with no draft at all is not dirty', () => {
		expect(isTabDirty('table', 'tbl:nope')).toBe(false);
		expect(isTabDirty('navigation', 'nav:nope')).toBe(false);
	});

	it('a nav draft tab turns dirty on edit', async () => {
		const draft = await ensureDraft('nav:draft:1');
		updateDefinition('nav:draft:1', draft.definition);
		expect(isTabDirty('navigation', 'nav:draft:1')).toBe(true);
	});

	it('isArtifactDirty maps an artifact id onto its deterministic tab id', async () => {
		// Simulate an OPEN saved artifact: its tab id is tbl:<artifactId>.
		const template = await ensureTableDraft('tbl:draft:9');
		vi.spyOn(artifactsApi, 'getArtifact').mockResolvedValue({
			id: 'a1',
			kind: 'table',
			name: 'T',
			artifact_rev: 1,
			payload: template.definition
		} as never);
		expect(isArtifactDirty('table', 'a1')).toBe(false); // not open: no draft
		await ensureTableDraft('tbl:a1');
		expect(isArtifactDirty('table', 'a1')).toBe(false); // open but pristine
		updateTableDefinition('tbl:a1', template.definition);
		expect(isArtifactDirty('table', 'a1')).toBe(true); // edited
	});

	it('the metamodel tab is dirty while a node move is staged, with no dirty buffer', () => {
		// The tab marker has to cover BOTH halves of the family: a user who only
		// dragged nodes has uncommitted metamodel work, and the buffer-vs-baseline
		// check alone reports it clean.
		expect(isTabDirty('metamodel', 'metamodel')).toBe(false);
		stageNodeMove('el:Pump', { x: 4, y: 5 });
		expect(isTabDirty('metamodel', 'metamodel')).toBe(true);
	});

	it('snippet drafts drive isTabDirty/isArtifactDirty/hasUnsavedWork', async () => {
		const tabId = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		await ensureSnippetDraft(tabId);
		expect(isTabDirty('snippet', tabId)).toBe(true); // never-saved draft counts
		// hasUnsavedWork/hasDirtySnippetDrafts is dirty-flag-only: a fresh,
		// untouched draft starts empty (DEFAULT_CODE === ''), so there is
		// nothing to lose yet — unlike isTabDirty's tab-marker rule above.
		expect(hasUnsavedWork()).toBe(false);
		updateSnippetCode(tabId, 'print(1)\n');
		expect(hasUnsavedWork()).toBe(true);
		expect(isArtifactDirty('code_snippet', 'nope')).toBe(false);
	});
});
