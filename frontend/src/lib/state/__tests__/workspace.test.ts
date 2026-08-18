import { beforeEach, describe, expect, it } from 'vitest';
import {
	bindTabToArtifact,
	closeTab,
	getActiveTab,
	getDynamicTabs,
	initWorkspaceTabs,
	openArtifactTab,
	openIssuesTab,
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

	it('closing the active tab yields null when it was the only tab', () => {
		initWorkspaceTabs('p1');
		const id = openNavigationTab({ artifactId: null, title: 'New navigation' });
		closeTab(id);
		expect(getActiveTab()).toBeNull();
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
		expect(getActiveTab()).toBeNull();
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
		const other = openNavigationTab({ artifactId: 'a1', title: 'Other' });
		setActiveTab(other);
		expect(openMetamodelTab()).toBe(id);
		expect(getDynamicTabs()).toHaveLength(2);
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
		expect(getActiveTab()).toBeNull();
	});
});

describe('issues tab', () => {
	it('openIssuesTab creates a singleton and focuses it', () => {
		const id = openIssuesTab();
		expect(id).toBe('issues:panel');
		expect(getActiveTab()).toBe('issues:panel');
		const again = openIssuesTab();
		expect(again).toBe('issues:panel');
		expect(getDynamicTabs().filter((t) => t.kind === 'issues')).toHaveLength(1);
	});
});

describe('nullable active tab', () => {
	it('starts with no active tab', () => {
		expect(getActiveTab()).toBeNull();
		expect(getDynamicTabs()).toEqual([]);
	});

	it('closing the active tab focuses the previous tab in strip order', () => {
		const a = openArtifactTab('table', { artifactId: 'A', title: 'A' });
		const b = openArtifactTab('table', { artifactId: 'B', title: 'B' });
		const c = openArtifactTab('table', { artifactId: 'C', title: 'C' });
		setActiveTab(b);
		closeTab(b);
		expect(getActiveTab()).toBe(a);
		closeTab(a);
		expect(getActiveTab()).toBe(c); // index-1 clamped to 0 of what remains
	});

	it('closing a non-edge active tab focuses its true predecessor, not the first tab', () => {
		// Discriminates the idx-1 rule from a naive "always focus index 0"
		// implementation: closing c (index 2) out of [a,b,c,d] must land on b,
		// not a — a naive always-first rule would wrongly return a here.
		openArtifactTab('table', { artifactId: 'A', title: 'A' });
		const b = openArtifactTab('table', { artifactId: 'B', title: 'B' });
		const c = openArtifactTab('table', { artifactId: 'C', title: 'C' });
		openArtifactTab('table', { artifactId: 'D', title: 'D' });
		setActiveTab(c);
		closeTab(c);
		expect(getActiveTab()).toBe(b);
	});

	it('closing the last tab yields null', () => {
		const a = openArtifactTab('table', { artifactId: 'A', title: 'A' });
		closeTab(a);
		expect(getActiveTab()).toBeNull();
	});

	it('closing an inactive tab leaves the active tab alone', () => {
		const a = openArtifactTab('table', { artifactId: 'A', title: 'A' });
		const b = openArtifactTab('table', { artifactId: 'B', title: 'B' });
		expect(getActiveTab()).toBe(b);
		closeTab(a);
		expect(getActiveTab()).toBe(b);
	});

	it('restore of a legacy builtin active id falls back to null', () => {
		localStorage.setItem(
			'ui.workspace.tabs.p1',
			JSON.stringify({ active: 'detail', tabs: [] })
		);
		initWorkspaceTabs('p1');
		expect(getActiveTab()).toBeNull();
	});

	it('the issues tab persists and restores', () => {
		initWorkspaceTabs('p2');
		openIssuesTab();
		resetWorkspaceTabs();
		initWorkspaceTabs('p2');
		expect(getDynamicTabs().some((t) => t.kind === 'issues')).toBe(true);
	});
});
