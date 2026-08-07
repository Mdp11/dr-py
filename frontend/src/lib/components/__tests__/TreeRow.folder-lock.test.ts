import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { handleFeedEvent, resetRealtime } from '$lib/state/realtime.svelte';
import { setCurrentUserId } from '$lib/api/identity';
import { indexIssues, resetArtifacts, clearViewState } from '$lib/state';
import TreeRow from '../Sidebar/TreeRow.svelte';
import {
	folderKey,
	type DndContext,
	type UnifiedTree,
	type Visibility
} from '../Sidebar/view-tree';

function emptyTree(overrides: Partial<UnifiedTree> = {}): UnifiedTree {
	return {
		roots: [],
		excludedRoots: [],
		children: new Map(),
		kind: new Map(),
		folderName: new Map(),
		folderPathNames: new Map(),
		placedElementIds: new Set(),
		artifactRef: new Map(),
		...overrides
	};
}

const NOOP_DND: DndContext = { onPointerDown: () => {}, hoverKey: null, hoverValid: false };

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

function mountFolderRow(key: string, tree: UnifiedTree): void {
	app = mount(TreeRow, {
		target: host,
		props: {
			row: { key, depth: 0 },
			tree,
			elementsById: new Map<string, never>(),
			visibility: new Map<string, Visibility>([[key, 'full']]),
			collapsed: new Set<string>(),
			childCounts: new Map<string, number>(),
			excludedTotal: 0,
			folderOptions: [],
			warningsByElementId: new Set<string>(),
			issueIndex: indexIssues([]),
			selectedId: null,
			multiSelectedIds: new Set<string>(),
			focusedId: null,
			parentFolderId: null,
			siblingIndex: 0,
			folderLen: 0,
			movable: false,
			dnd: NOOP_DND,
			onToggle: () => {},
			onPick: () => {},
			onMoveToFolder: () => {}
		}
	});
	flushSync();
}

beforeEach(() => {
	resetArtifacts();
	clearViewState();
	resetRealtime();
	host = document.createElement('div');
	document.body.appendChild(host);
});

afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	setCurrentUserId('');
	vi.restoreAllMocks();
});

describe('TreeRow — folder peer-lock badge', () => {
	it('renders no lock badge for an unlocked folder', () => {
		const key = folderKey('F');
		const tree = emptyTree({ kind: new Map([[key, 'folder']]), folderName: new Map([[key, 'F']]) });

		mountFolderRow(key, tree);

		expect(host.querySelector('[aria-label="has warnings"]')).toBeNull();
		expect(host.textContent ?? '').not.toContain('Locked by');
	});

	it('a peer folder lease renders a lock badge on the folder row', () => {
		setCurrentUserId('default-user');
		handleFeedEvent({
			type: 'lock',
			action: 'acquired',
			leases: [{ resource_id: 'folder:F', mode: 'exclusive', holder_id: 'bob' }]
		});
		const key = folderKey('F');
		const tree = emptyTree({ kind: new Map([[key, 'folder']]), folderName: new Map([[key, 'F']]) });

		mountFolderRow(key, tree);

		const lockIcon = host.querySelector('svg[aria-label], [title^="Locked by"]');
		expect(lockIcon).not.toBeNull();
		expect(lockIcon?.getAttribute('title')).toBe('Locked by bob');
	});

	it('prefers the holder email over the opaque id in the badge title', () => {
		handleFeedEvent({
			type: 'lock',
			action: 'acquired',
			leases: [
				{
					resource_id: 'folder:F',
					mode: 'exclusive',
					holder_id: 'bob-uuid',
					holder_email: 'bob@x.io'
				}
			]
		});
		const key = folderKey('F');
		const tree = emptyTree({ kind: new Map([[key, 'folder']]), folderName: new Map([[key, 'F']]) });

		mountFolderRow(key, tree);

		const lockIcon = host.querySelector('[title^="Locked by"]');
		expect(lockIcon?.getAttribute('title')).toBe('Locked by bob@x.io');
	});

	it('renders no badge when the lease is my own', () => {
		setCurrentUserId('default-user');
		handleFeedEvent({
			type: 'lock',
			action: 'acquired',
			leases: [{ resource_id: 'folder:F', mode: 'exclusive', holder_id: 'default-user' }]
		});
		const key = folderKey('F');
		const tree = emptyTree({ kind: new Map([[key, 'folder']]), folderName: new Map([[key, 'F']]) });

		mountFolderRow(key, tree);

		expect(host.textContent ?? '').not.toContain('Locked by');
	});
});
