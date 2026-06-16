import type { ViewChange } from './view-diff';

const joinPath = (path: string[]): string => (path.length === 0 ? '(root)' : path.join('/'));

/**
 * Human-readable one-line description of a single view change. `resolveName`
 * maps an element id to its display name (falling back to the id itself).
 */
export function formatViewChange(change: ViewChange, resolveName: (id: string) => string): string {
	switch (change.kind) {
		case 'element-moved':
			return `${resolveName(change.id)} moved from '${joinPath(change.from)}' to '${joinPath(change.to)}'`;
		case 'element-removed':
			return `${resolveName(change.id)} removed from view`;
		case 'element-added':
			return `${resolveName(change.id)} added to '${joinPath(change.to)}'`;
		case 'folder-added':
			return `Folder '${joinPath(change.path)}' created`;
		case 'folder-removed':
			return `Folder '${joinPath(change.path)}' deleted`;
	}
}
