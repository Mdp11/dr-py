import { beforeEach, describe, expect, it } from 'vitest';
import {
	bindTabToArtifact,
	closeTab,
	getActiveTab,
	getDynamicTabs,
	initWorkspaceTabs,
	openArtifactTab,
	openNavigationTab,
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

	it('opens snippet tabs under the snip prefix and dedupes by artifact', () => {
		const a = openArtifactTab('snippet', { artifactId: 's1', title: 'S' });
		expect(a).toBe('snip:s1');
		const b = openArtifactTab('snippet', { artifactId: 's1', title: 'S' });
		expect(b).toBe(a);
		const draft = openArtifactTab('snippet', { artifactId: null, title: 'New snippet' });
		expect(draft).toMatch(/^snip:draft:/);
	});
});
