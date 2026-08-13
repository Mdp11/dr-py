import { beforeEach, describe, expect, it } from 'vitest';
import {
	bindTabToArtifact,
	closeTab,
	getActiveTab,
	getDynamicTabs,
	initWorkspaceTabs,
	openArtifactTab,
	openMetamodelTab,
	openNavigationTab,
	repointTabArtifact,
	resetWorkspaceTabs,
	setActiveTab
} from '../workspace.svelte';

beforeEach(() => {
	localStorage.clear();
	resetWorkspaceTabs();
});

describe('dynamic workspace tabs', () => {
	it('defaults to detail with no dynamic tabs', () => {
		expect(getActiveTab()).toBe('detail');
		expect(getDynamicTabs()).toEqual([]);
	});

	it('opens, activates, and dedupes navigation tabs by artifact', () => {
		initWorkspaceTabs('p1');
		const id = openNavigationTab({ artifactId: 'a1', title: 'Sensors' });
		expect(id).toBe('nav:a1');
		expect(getActiveTab()).toBe(id);
		const again = openNavigationTab({ artifactId: 'a1', title: 'Sensors' });
		expect(again).toBe(id);
		expect(getDynamicTabs()).toHaveLength(1);
	});

	it('openArtifactTab creates a tbl: tab for a table', () => {
		const id = openArtifactTab('table', { artifactId: 'abc', title: 'T' });
		expect(id).toBe('tbl:abc');
		expect(getDynamicTabs().find((t) => t.id === id)?.kind).toBe('table');
	});

	it('bindTabToArtifact keeps the table prefix', () => {
		const id = openArtifactTab('table', { artifactId: null, title: 'draft' });
		expect(id.startsWith('tbl:draft:')).toBe(true);
		bindTabToArtifact(id, 'saved1');
		expect(getDynamicTabs().find((t) => t.artifactId === 'saved1')?.id).toBe('tbl:saved1');
	});

	it('closing the active tab falls back to detail', () => {
		initWorkspaceTabs('p1');
		const id = openNavigationTab({ artifactId: null, title: 'New navigation' });
		closeTab(id);
		expect(getActiveTab()).toBe('detail');
		expect(getDynamicTabs()).toEqual([]);
	});

	it('persists saved tabs per project, not drafts', () => {
		initWorkspaceTabs('p1');
		openNavigationTab({ artifactId: 'a1', title: 'Sensors' });
		openNavigationTab({ artifactId: null, title: 'New navigation' });
		resetWorkspaceTabs();
		initWorkspaceTabs('p1');
		const tabs = getDynamicTabs();
		expect(tabs).toHaveLength(1);
		expect(tabs[0].artifactId).toBe('a1');
	});

	it('bindTabToArtifact converts a draft into a persisted saved tab', () => {
		initWorkspaceTabs('p1');
		const id = openNavigationTab({ artifactId: null, title: 'New navigation' });
		bindTabToArtifact(id, 'a9');
		setActiveTab(getDynamicTabs()[0].id);
		resetWorkspaceTabs();
		initWorkspaceTabs('p1');
		expect(getDynamicTabs()[0].artifactId).toBe('a9');
	});

	it('switching to a project with no persisted tabs clears the prior project state', () => {
		initWorkspaceTabs('p1');
		openNavigationTab({ artifactId: 'a1', title: 'Sensors' });
		// Simulate client-side project navigation (no resetWorkspaceTabs in between):
		// module-level state must not leak from p1 into p2.
		initWorkspaceTabs('p2');
		expect(getDynamicTabs()).toEqual([]);
		expect(getActiveTab()).toBe('detail');
	});

	it('repointTabArtifact moves the record without moving the tab key', () => {
		initWorkspaceTabs('p1');
		// The only shape that uses it: a DRAFT tab whose editor staged a create.
		const id = openNavigationTab({ artifactId: null, title: 'New navigation' });
		repointTabArtifact(id, 'tmp_new');
		expect(getDynamicTabs()[0].id).toBe(id); // key unchanged (nav:draft:N)
		expect(getDynamicTabs()[0].artifactId).toBe('tmp_new');
		repointTabArtifact(id, null); // the staged create was discarded
		expect(getDynamicTabs()[0].id).toBe(id);
		expect(getDynamicTabs()[0].artifactId).toBeNull();
	});

	it('does not persist a tab pointed at a temp (staged, uncommitted) id', () => {
		initWorkspaceTabs('p1');
		const id = openNavigationTab({ artifactId: null, title: 'New navigation' });
		repointTabArtifact(id, 'tmp_new');
		resetWorkspaceTabs();
		initWorkspaceTabs('p1');
		// The staged buffer does not survive a reload either — restoring the tab
		// would resurrect a ghost pointed at an id the server never minted.
		expect(getDynamicTabs()).toEqual([]);
	});

	it('opens snippet tabs under the snip prefix and dedupes by artifact', () => {
		const a = openArtifactTab('snippet', { artifactId: 's1', title: 'S' });
		expect(a).toBe('snip:s1');
		const b = openArtifactTab('snippet', { artifactId: 's1', title: 'S' });
		expect(b).toBe(a);
		const draft = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		expect(draft).toMatch(/^snip:draft:/);
	});

	it('opens custom_export tabs under the exp prefix', () => {
		const id = openArtifactTab('custom_export', { artifactId: 'a', title: 't' });
		expect(id).toBe('exp:a');
		expect(getDynamicTabs().find((t) => t.id === id)?.kind).toBe('custom_export');
	});
});

describe('metamodel singleton tab', () => {
	it('opens once and focuses on reopen', () => {
		initWorkspaceTabs('p1');
		const id = openMetamodelTab();
		expect(id).toBe('mm:editor');
		expect(getDynamicTabs()).toHaveLength(1);
		setActiveTab('detail');
		expect(openMetamodelTab()).toBe(id);
		expect(getDynamicTabs()).toHaveLength(1);
		expect(getActiveTab()).toBe(id);
	});

	it('persists across init despite having no artifact', () => {
		initWorkspaceTabs('p1');
		openMetamodelTab();
		resetWorkspaceTabs();
		initWorkspaceTabs('p1');
		expect(getDynamicTabs().map((t) => t.kind)).toContain('metamodel');
	});

	it('closes like any tab', () => {
		initWorkspaceTabs('p1');
		const id = openMetamodelTab();
		closeTab(id);
		expect(getDynamicTabs()).toEqual([]);
		expect(getActiveTab()).toBe('detail');
	});
});
