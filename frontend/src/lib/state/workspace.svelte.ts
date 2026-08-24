/**
 * Workspace tab strip: dynamic-tabs-only (navigation and table editors, the
 * metamodel editor, and the Issues panel — all closable). There is no fixed
 * built-in tab: a `null` active id means "nothing open", and the
 * Workspace renders a placeholder in that state. Saved-artifact tabs are
 * persisted per project under `ui.workspace.tabs.<projectId>`; DRAFT tabs are
 * memory-only by design — that means `artifactId === null` AND a TEMP id (a
 * staged-but-uncommitted create, see {@link repointTabArtifact}): the staged
 * buffer does not survive a reload, so restoring a tab pointed at a temp id
 * that will never exist would resurrect a ghost.
 */

import { isTempId } from './ops';

export type WorkspaceTab = string;

export interface DynamicTab {
	id: string;
	kind: 'navigation' | 'table' | 'snippet' | 'metamodel' | 'exporter' | 'rules' | 'issues';
	artifactId: string | null;
	title: string;
}

const PREFIX = {
	navigation: 'nav',
	table: 'tbl',
	snippet: 'snip',
	metamodel: 'mm',
	exporter: 'exp',
	rules: 'rules',
	issues: 'issues'
} as const;

let _activeTab: string | null = $state(null);
let _tabs = $state<DynamicTab[]>([]);
let _projectId: string | null = null;
let _draftSeq = 0;

export function getActiveTab(): string | null {
	return _activeTab;
}
export function setActiveTab(t: string): void {
	_activeTab = t;
	persist();
}
export function getDynamicTabs(): DynamicTab[] {
	return _tabs;
}

export function openArtifactTab(
	kind: 'navigation' | 'table' | 'snippet' | 'exporter' | 'rules',
	opts: { artifactId: string | null; title: string }
): string {
	const p = PREFIX[kind];
	if (opts.artifactId !== null) {
		const existing = _tabs.find((t) => t.artifactId === opts.artifactId && t.kind === kind);
		if (existing) {
			_activeTab = existing.id;
			persist();
			return existing.id;
		}
	}
	const id = opts.artifactId === null ? `${p}:draft:${++_draftSeq}` : `${p}:${opts.artifactId}`;
	_tabs = [..._tabs, { id, kind, artifactId: opts.artifactId, title: opts.title }];
	_activeTab = id;
	persist();
	return id;
}

export function openNavigationTab(opts: { artifactId: string | null; title: string }): string {
	return openArtifactTab('navigation', opts);
}

const METAMODEL_TAB_ID = 'mm:editor';

/** Open (or focus) the singleton metamodel editor tab. Not artifact-backed;
 * dedupe is by KIND, which is why it does not go through openArtifactTab. */
export function openMetamodelTab(): string {
	const existing = _tabs.find((t) => t.kind === 'metamodel');
	if (existing) {
		_activeTab = existing.id;
		persist();
		return existing.id;
	}
	_tabs = [
		..._tabs,
		{ id: METAMODEL_TAB_ID, kind: 'metamodel', artifactId: null, title: 'Metamodel' }
	];
	_activeTab = METAMODEL_TAB_ID;
	persist();
	return METAMODEL_TAB_ID;
}

const ISSUES_TAB_ID = 'issues:panel';

/** Open (or focus) the singleton Issues tab. Not artifact-backed; dedupe is
 * by KIND, mirroring openMetamodelTab. */
export function openIssuesTab(): string {
	const existing = _tabs.find((t) => t.kind === 'issues');
	if (existing) {
		_activeTab = existing.id;
		persist();
		return existing.id;
	}
	_tabs = [..._tabs, { id: ISSUES_TAB_ID, kind: 'issues', artifactId: null, title: 'Issues' }];
	_activeTab = ISSUES_TAB_ID;
	persist();
	return ISSUES_TAB_ID;
}

/**
 * Close a tab. If it was active, focus its PREDECESSOR in strip order — the
 * tab at index-1, clamped to the start so closing the first tab focuses the
 * new first. This mirrors how browser/editor tab strips keep focus near where
 * the closed tab was rather than jumping to a fixed home. An empty strip
 * leaves the active tab `null` — "nothing open".
 */
export function closeTab(id: string): void {
	const idx = _tabs.findIndex((t) => t.id === id);
	_tabs = _tabs.filter((t) => t.id !== id);
	if (_activeTab === id) {
		_activeTab = _tabs.length > 0 ? _tabs[Math.max(0, idx - 1)].id : null;
	}
	persist();
}

export function retitleTab(id: string, title: string): void {
	_tabs = _tabs.map((t) => (t.id === id ? { ...t, title } : t));
	persist();
}

/**
 * Repoint a tab record's `artifactId` WITHOUT re-keying the tab id — the
 * staging half of {@link bindTabToArtifact}.
 *
 * Used by an artifact editor that stages a create from a DRAFT tab: the draft
 * adopts a TEMP id immediately, but the tab keeps its `<p>:draft:N` key until
 * the commit mints a real id (that key names no artifact, so it can never
 * collide with the deterministic `<p>:<artifactId>` {@link openArtifactTab}
 * builds — which is why this is safe HERE and would not be on a tab already
 * keyed to a real artifact). The record must follow the draft even so:
 * `openArtifactTab` dedupes on `artifactId`, and the sidebar addresses a staged
 * create by its temp id. Pass `null` to unbind again (a discarded create).
 */
export function repointTabArtifact(id: string, artifactId: string | null): void {
	_tabs = _tabs.map((t) => (t.id === id ? { ...t, artifactId } : t));
	persist();
}

/** After a create COMMITS: bind the tab to its new artifact id (re-keyed). */
export function bindTabToArtifact(id: string, artifactId: string): void {
	_tabs = _tabs.map((t) =>
		t.id === id ? { ...t, id: `${PREFIX[t.kind]}:${artifactId}`, artifactId } : t
	);
	const bound = _tabs.find((t) => t.artifactId === artifactId);
	if (_activeTab === id && bound) _activeTab = bound.id;
	persist();
}

function storageKey(): string | null {
	return _projectId ? `ui.workspace.tabs.${_projectId}` : null;
}

/** True when a tab is worth persisting: it is bound to an artifact the SERVER
 * knows about. See the module docstring for why a temp id is not one. */
function persistable(t: DynamicTab): boolean {
	// The metamodel and issues tabs have no artifact but are stable singletons
	// — restoring them is cheap (the metamodel draft persists independently
	// via ui.metamodel.draft.*; the issues tab has no draft of its own).
	if (t.kind === 'metamodel' || t.kind === 'issues') return true;
	return t.artifactId !== null && !isTempId(t.artifactId);
}

function persist(): void {
	const key = storageKey();
	if (!key) return;
	const saved = _tabs.filter(persistable);
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
		if (!raw) {
			_tabs = [];
			_activeTab = null;
			return;
		}
		const parsed = JSON.parse(raw) as { active?: string | null; tabs?: DynamicTab[] };
		_tabs = (parsed.tabs ?? [])
			.filter(persistable)
			.map((t) => ({ ...t, kind: t.kind ?? 'navigation' }));
		const active = parsed.active ?? null;
		_activeTab = active !== null && _tabs.some((t) => t.id === active) ? active : null;
	} catch {
		_tabs = [];
		_activeTab = null;
	}
}

export function resetWorkspaceTabs(): void {
	_activeTab = null;
	_tabs = [];
	_projectId = null;
	_draftSeq = 0;
}
