import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import * as viewApi from '$lib/api/view';
import type { View } from '$lib/api/types';
import { clearViewState, getView, indexIssues, pushView, resetArtifacts } from '$lib/state';
import TreeRow from '../Sidebar/TreeRow.svelte';
import {
	artifactKey,
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
		placedElementIds: new Set(),
		artifactRef: new Map(),
		...overrides
	};
}

const NOOP_DND: DndContext = { onPointerDown: () => {}, hoverKey: null, hoverValid: false };

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

beforeEach(() => {
	resetArtifacts();
	clearViewState();
	host = document.createElement('div');
	document.body.appendChild(host);
});

afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	vi.restoreAllMocks();
});

describe('TreeRow — dangling artifact refs', () => {
	it('renders a visible, muted "missing artifact" row with an id fallback for an unknown artifact id', () => {
		const key = artifactKey('ghost');
		const tree = emptyTree({
			kind: new Map([[key, 'artifact']]),
			artifactRef: new Map([[key, { id: 'ghost', kind: 'navigation' }]])
		});
		const visibility = new Map<string, Visibility>([[key, 'full']]);
		app = mount(TreeRow, {
			target: host,
			props: {
				row: { key, depth: 0 },
				tree,
				elementsById: new Map<string, never>(),
				visibility,
				collapsed: new Set<string>(),
				childCounts: new Map<string, number>(),
				excludedTotal: 0,
				folderOptions: [],
				warningsByElementId: new Set<string>(),
				issueIndex: indexIssues([]),
				selectedId: null,
				multiSelectedIds: new Set<string>(),
				focusedId: null,
				parentFolderPath: ['F'],
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
		// Visible content, not a blank windowing slot — and the artifact id
		// stands in as the display-name fallback (no header to draw a real name
		// from).
		expect(host.textContent).toContain('missing artifact');
		expect(host.textContent).toContain('ghost');
		// No dblclick-to-open affordance for a ref that resolves to nothing.
		const row = host.querySelector('[role="treeitem"]');
		expect(row).not.toBeNull();
		expect(row?.hasAttribute('ondblclick')).toBe(false);
		// Not draggable: no drag-start wiring on the row.
		expect(row?.getAttribute('style') ?? '').not.toContain('touch-action: none');
	});

	it('the remove button on a dangling ref removes it from its folder (right folder path + id)', async () => {
		const key = artifactKey('ghost');
		const tree = emptyTree({
			kind: new Map([[key, 'artifact']]),
			artifactRef: new Map([[key, { id: 'ghost', kind: 'navigation' }]])
		});
		const visibility = new Map<string, Visibility>([[key, 'full']]);
		const seedView: View = {
			name: 'v',
			folders: [
				{
					name: 'F',
					folders: [],
					elements: [],
					artifacts: [
						{ id: 'ghost', kind: 'navigation' },
						{ id: 'kept', kind: 'navigation' }
					]
				}
			]
		};
		vi.spyOn(viewApi, 'putViewSnapshot').mockImplementation(async (v) => ({
			view: v,
			warnings: []
		}));
		await pushView(seedView);

		app = mount(TreeRow, {
			target: host,
			props: {
				row: { key, depth: 0 },
				tree,
				elementsById: new Map<string, never>(),
				visibility,
				collapsed: new Set<string>(),
				childCounts: new Map<string, number>(),
				excludedTotal: 0,
				folderOptions: [],
				warningsByElementId: new Set<string>(),
				issueIndex: indexIssues([]),
				selectedId: null,
				multiSelectedIds: new Set<string>(),
				focusedId: null,
				parentFolderPath: ['F'],
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

		const removeBtn = host.querySelector('button[aria-label="Remove from folder"]');
		expect(removeBtn).not.toBeNull();
		removeBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		// removeArtifactFromFolder is async (pushView round-trip) — flush the microtask.
		await Promise.resolve();
		await Promise.resolve();
		flushSync();

		const view = getView()!;
		expect(view.folders[0].artifacts).toEqual([{ id: 'kept', kind: 'navigation' }]);
	});
});
