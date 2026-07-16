import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as tablesApi from '$lib/api/tables';
import {
	closeTableDraft,
	emit,
	ensureDraft,
	ensureEmbeddedDraft,
	ensureTableDraft,
	hasDirtyNavDrafts,
	hasDirtyTableDrafts,
	resetModelStore,
	resetNavigationEditors,
	resetTableEditors,
	seedElements,
	updateDefinition,
	updateTableDefinition
} from '../index';
import { hasUnsavedWork } from '../unsaved';
import { resetWorkspaceTabs } from '../workspace.svelte';
import { resetArtifacts } from '../artifacts.svelte';

const EMPTY_PAGE = {
	columns: [],
	rows: [],
	total: 0,
	truncated: false,
	offset: 0,
	model_rev: 1
};

beforeEach(() => {
	resetModelStore();
	resetTableEditors();
	resetNavigationEditors();
	resetWorkspaceTabs();
	resetArtifacts();
	vi.spyOn(tablesApi, 'evaluateTable').mockResolvedValue(EMPTY_PAGE);
});
afterEach(() => {
	resetNavigationEditors();
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
});
