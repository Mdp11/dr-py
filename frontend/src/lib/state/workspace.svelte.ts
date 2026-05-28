export type WorkspaceTab = 'detail' | 'graph' | 'issues';

let _activeTab: WorkspaceTab = $state('detail');

export function getActiveTab(): WorkspaceTab {
	return _activeTab;
}

export function setActiveTab(t: WorkspaceTab): void {
	_activeTab = t;
}
