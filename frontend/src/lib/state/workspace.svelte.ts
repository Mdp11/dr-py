/**
 * Workspace tab strip: three fixed built-ins (detail/graph/issues) plus
 * dynamic closable tabs (Stage 1: navigation editors; tables/diagrams later).
 * The active id is either a built-in literal or a dynamic tab id, so existing
 * `setActiveTab('detail')` call sites are untouched. Saved-artifact tabs are
 * persisted per project under `ui.workspace.tabs.<projectId>`; DRAFT tabs
 * (unsaved definitions, artifactId null) are memory-only by design.
 */

export type WorkspaceTab = string;
export const BUILTIN_TABS = ['detail', 'graph', 'issues'] as const;

export interface DynamicTab {
	id: string;
	kind: 'navigation';
	artifactId: string | null;
	title: string;
}

let _activeTab: string = $state('detail');
let _tabs = $state<DynamicTab[]>([]);
let _projectId: string | null = null;
let _draftSeq = 0;

export function getActiveTab(): string {
	return _activeTab;
}
export function setActiveTab(t: string): void {
	_activeTab = t;
	persist();
}
export function getDynamicTabs(): DynamicTab[] {
	return _tabs;
}

export function openNavigationTab(opts: { artifactId: string | null; title: string }): string {
	if (opts.artifactId !== null) {
		const existing = _tabs.find((t) => t.artifactId === opts.artifactId);
		if (existing) {
			_activeTab = existing.id;
			persist();
			return existing.id;
		}
	}
	const id = opts.artifactId === null ? `nav:draft:${++_draftSeq}` : `nav:${opts.artifactId}`;
	_tabs = [..._tabs, { id, kind: 'navigation', artifactId: opts.artifactId, title: opts.title }];
	_activeTab = id;
	persist();
	return id;
}

export function closeTab(id: string): void {
	_tabs = _tabs.filter((t) => t.id !== id);
	if (_activeTab === id) _activeTab = 'detail';
	persist();
}

export function retitleTab(id: string, title: string): void {
	_tabs = _tabs.map((t) => (t.id === id ? { ...t, title } : t));
	persist();
}

/** After the first save of a draft: bind it to its new artifact id (re-keyed). */
export function bindTabToArtifact(id: string, artifactId: string): void {
	const newId = `nav:${artifactId}`;
	_tabs = _tabs.map((t) => (t.id === id ? { ...t, id: newId, artifactId } : t));
	if (_activeTab === id) _activeTab = newId;
	persist();
}

function storageKey(): string | null {
	return _projectId ? `ui.workspace.tabs.${_projectId}` : null;
}

function persist(): void {
	const key = storageKey();
	if (!key) return;
	const saved = _tabs.filter((t) => t.artifactId !== null);
	try {
		localStorage.setItem(key, JSON.stringify({ active: _activeTab, tabs: saved }));
	} catch {
		/* storage full/denied: tabs simply don't persist */
	}
}

export function initWorkspaceTabs(projectId: string): void {
	_projectId = projectId;
	try {
		const raw = localStorage.getItem(`ui.workspace.tabs.${projectId}`);
		if (!raw) return;
		const parsed = JSON.parse(raw) as { active?: string; tabs?: DynamicTab[] };
		_tabs = (parsed.tabs ?? []).filter((t) => t.artifactId !== null);
		const active = parsed.active ?? 'detail';
		_activeTab =
			(BUILTIN_TABS as readonly string[]).includes(active) || _tabs.some((t) => t.id === active)
				? active
				: 'detail';
	} catch {
		_tabs = [];
		_activeTab = 'detail';
	}
}

export function resetWorkspaceTabs(): void {
	_activeTab = 'detail';
	_tabs = [];
	_projectId = null;
	_draftSeq = 0;
}
