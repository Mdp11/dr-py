import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import type { Metamodel } from '$lib/api/types';
import type { MetamodelDiagramView, MetamodelEditorView } from '$lib/state';

/**
 * Canvas + view-toggle tests (Task 10). The state module is mocked wholesale so
 * these exercise the COMPONENTS: what the canvas draws for a given view
 * snapshot, what it hides when the surface is read-only, and which state calls
 * a gesture makes. Task 9's own suite covers the module behind those calls.
 *
 * The YAML editor is stubbed out (CodeMirror needs a real layout engine and has
 * nothing to do with the toggle); the diagram half is deliberately NOT stubbed,
 * so the tab test proves the real canvas mounts.
 */

vi.mock('../Metamodel/MetamodelYamlEditor.svelte', () => ({ default: () => {} }));

const MM: Metamodel = {
	enums: { Status: ['Draft', 'Active'] },
	elements: [
		{
			name: 'Zone',
			abstract: false,
			extends: null,
			key: ['name'],
			properties: [
				{
					name: 'name',
					datatype: 'string',
					multiplicity: '1',
					min: null,
					max: null,
					pattern: null,
					max_length: null
				}
			]
		},
		{ name: 'Building', abstract: false, extends: null, key: null, properties: [] }
	],
	relationships: [
		{
			name: 'Contains',
			abstract: false,
			extends: null,
			containment: true,
			source: 'Zone',
			target: 'Building',
			mappings: [{ source: 'Zone', target: 'Building' }],
			source_multiplicity: '1',
			target_multiplicity: '0..*',
			properties: []
		}
	]
};

const EDITOR: MetamodelEditorView = {
	phase: 'ready',
	loadError: null,
	source: 'stored',
	buffer: 'elements: []',
	dirty: false,
	readOnly: false,
	lockedBy: null,
	draftRestored: false,
	lintErrors: [],
	preview: null,
	previewCurrent: false,
	previewing: false,
	previewError: null,
	rebinding: false,
	rebindError: null
};

const DIAGRAM: MetamodelDiagramView = {
	view: 'diagram',
	mm: MM,
	parseErrors: [],
	selection: null,
	positions: {
		'el:Zone': { x: 0, y: 0 },
		'el:Building': { x: 320, y: 0 },
		'enum:Status': { x: 0, y: 200 }
	},
	collapsed: new Set(),
	canUndo: false,
	errorNodeIds: new Set(),
	unattributedErrorCount: 0
};

let editorView: MetamodelEditorView = EDITOR;
let diagramView: MetamodelDiagramView = DIAGRAM;
let role: 'owner' | 'editor' | 'viewer' = 'owner';

/**
 * The chosen surface, held in a `SvelteMap` rather than a plain variable: the
 * tab reads it through a `$derived`, so the toggle can only be observed
 * in-place if the read registers a real signal. `SvelteMap` builds its signals
 * at runtime, which is what makes it usable from a plain `.ts` test file.
 */
const surface = new SvelteMap<'view', 'yaml' | 'diagram'>();

vi.mock('$lib/state', async (orig) => {
	const actual = await orig<typeof import('$lib/state')>();
	return {
		...actual,
		getActiveProjectId: vi.fn(() => 'p1'),
		getRole: vi.fn(() => role),
		isProjectQuiet: vi.fn(() => true),
		getMetamodelEditor: vi.fn(() => editorView),
		getMetamodelDiagramView: vi.fn(
			(): MetamodelDiagramView => ({
				...diagramView,
				view: surface.get('view') ?? diagramView.view
			})
		),
		initMetamodelEditor: vi.fn(async () => {}),
		closeMetamodelEditor: vi.fn(),
		editMetamodelBuffer: vi.fn(),
		discardMetamodelDraft: vi.fn(),
		previewMetamodelChanges: vi.fn(async () => {}),
		commitMetamodelRebind: vi.fn(async () => null),
		retryMetamodelLease: vi.fn(),
		setMetamodel: vi.fn(),
		adoptIssues: vi.fn(),
		refreshSummary: vi.fn(async () => {}),
		initMetamodelDiagram: vi.fn(async () => {}),
		closeMetamodelDiagram: vi.fn(),
		onMetamodelRebound: vi.fn(),
		setMetamodelView: vi.fn((v: 'yaml' | 'diagram') => surface.set('view', v)),
		selectDiagramNode: vi.fn(),
		toggleNodeCollapsed: vi.fn(),
		setAllCollapsed: vi.fn(),
		applyDiagramEdit: vi.fn(() => true),
		undoDiagramEdit: vi.fn(),
		moveNode: vi.fn(),
		runAutoArrange: vi.fn(async () => {})
	};
});

// Imported AFTER the factory so these are the mocked bindings.
import { initMetamodelDiagram, selectDiagramNode, setMetamodelView } from '$lib/state';
import MetamodelTab from '../Metamodel/MetamodelTab.svelte';
import DiagramHost from './MetamodelDiagramHost.svelte';

function findButton(name: RegExp): HTMLButtonElement | undefined {
	return [...document.querySelectorAll('button')].find((b) => name.test(b.textContent ?? ''));
}

function nodeByText(text: string): HTMLElement | undefined {
	return [...document.querySelectorAll<HTMLElement>('.svelte-flow__node')].find((n) =>
		(n.textContent ?? '').includes(text)
	);
}

beforeEach(() => {
	editorView = EDITOR;
	diagramView = DIAGRAM;
	surface.clear();
	role = 'owner';
	document.body.innerHTML = '';
	vi.clearAllMocks();
});

afterEach(() => {
	document.body.innerHTML = '';
});

describe('MetamodelDiagram', () => {
	it('renders one node per element type, enum and boxed relationship', () => {
		const c = mount(DiagramHost, { target: document.body });
		flushSync();

		// `Contains` carries no properties and no inheritance, so Task 7's
		// association-class rule renders it as a boxless edge, not a node.
		expect(nodeByText('Zone')).toBeDefined();
		expect(nodeByText('Building')).toBeDefined();
		expect(nodeByText('Status')).toBeDefined();
		expect(document.querySelectorAll('.svelte-flow__node')).toHaveLength(3);

		unmount(c);
	});

	it('replaces the canvas with the YAML-view fallback when the draft has syntax errors', () => {
		diagramView = {
			...DIAGRAM,
			mm: null,
			parseErrors: [{ message: 'bad indent', line: 3, column: 1 }]
		};

		const c = mount(DiagramHost, { target: document.body });
		flushSync();

		expect(document.body.textContent).toContain('The draft has syntax errors');
		expect(document.querySelector('.svelte-flow')).toBeNull();

		findButton(/yaml/i)!.click();
		flushSync();
		expect(setMetamodelView).toHaveBeenCalledWith('yaml');

		unmount(c);
	});

	it('hides the create buttons on a read-only surface', () => {
		editorView = { ...EDITOR, readOnly: true };

		const c = mount(DiagramHost, { target: document.body });
		flushSync();

		expect(findButton(/element type/i)).toBeUndefined();
		expect(findButton(/enum/i)).toBeUndefined();
		// Browsing affordances stay: read-only is not view-only.
		expect(findButton(/auto-arrange/i)).toBeDefined();

		unmount(c);
	});

	it('selects the metamodel type behind a clicked node', () => {
		const c = mount(DiagramHost, { target: document.body });
		flushSync();

		nodeByText('Zone')!.click();
		flushSync();

		expect(selectDiagramNode).toHaveBeenCalledWith({ kind: 'element', name: 'Zone' });

		unmount(c);
	});
});

describe('MetamodelTab', () => {
	it('toggles between the YAML and diagram surfaces and persists the choice', async () => {
		diagramView = { ...DIAGRAM, view: 'yaml' };

		const c = mount(MetamodelTab, { target: document.body });
		flushSync();
		// initMetamodelDiagram is awaited behind initMetamodelEditor.
		await Promise.resolve();
		await Promise.resolve();
		flushSync();

		expect(initMetamodelDiagram).toHaveBeenCalledWith('p1');
		expect(document.querySelector('.svelte-flow')).toBeNull();

		findButton(/^diagram$/i)!.click();
		flushSync();

		expect(setMetamodelView).toHaveBeenCalledWith('diagram');
		expect(document.querySelector('.svelte-flow')).not.toBeNull();
		expect(nodeByText('Zone')).toBeDefined();

		unmount(c);
	});
});
