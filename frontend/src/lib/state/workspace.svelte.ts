/**
 * Workspace tab strip: three fixed built-ins (detail/graph/issues) plus
 * dynamic closable tabs (navigation and table editors; diagrams later).
 * The active id is either a built-in literal or a dynamic tab id, so existing
 * `setActiveTab('detail')` call sites are untouched. Saved-artifact tabs are
 * persisted per project under `ui.workspace.tabs.<projectId>`; DRAFT tabs are
 * memory-only by design — that means `artifactId === null` AND a TEMP id (a
 * staged-but-uncommitted create, see {@link repointTabArtifact}): the staged
 * buffer does not survive a reload, so restoring a tab pointed at a temp id
 * that will never exist would resurrect a ghost.
 */

import { isTempId } from './ops';

export type WorkspaceTab = string;
export const BUILTIN_TABS = ['detail', 'graph', 'issues'] as const;

export interface DynamicTab {
	id: string;
	kind: 'navigation' | 'table' | 'snippet';
	artifactId: string | null;
	title: string;
}

const PREFIX = { navigation: 'nav', table: 'tbl', snippet: 'snip' } as const;

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

export function openArtifactTab(
	kind: 'navigation' | 'table' | 'snippet',
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

export function closeTab(id: string): void {
	_tabs = _tabs.filter((t) => t.id !== id);
	if (_activeTab === id) _activeTab = 'detail';
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
			_activeTab = 'detail';
			return;
		}
		const parsed = JSON.parse(raw) as { active?: string; tabs?: DynamicTab[] };
		_tabs = (parsed.tabs ?? [])
			.filter(persistable)
			.map((t) => ({ ...t, kind: t.kind ?? 'navigation' }));
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
