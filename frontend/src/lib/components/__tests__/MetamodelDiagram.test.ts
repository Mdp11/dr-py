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
 *
 * **Nodes render here, EDGES DO NOT.** Svelte Flow only draws an edge once both
 * endpoint nodes have been measured, and happy-dom reports every element as
 * 0x0, so `.svelte-flow__edge` is always empty (verified: 0 elements with a
 * three-node diagram whose edges are all well-formed). Anything about edge
 * geometry, markers or stroke has to be asserted somewhere other than a mounted
 * canvas — don't write it here and conclude the component is broken.
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
	previewError: null
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
import {
	applyDiagramEdit,
	initMetamodelDiagram,
	selectDiagramNode,
	setMetamodelView
} from '$lib/state';
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
			parseErrors: [{ message: 'bad indent', line: 3 }]
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

	it('draws an expanded box whose type declares the same property name twice', () => {
		// `+ Property` used to emit a fixed `new_property`, so two clicks put two
		// identically-named rows on one type — and a draft is allowed to be
		// invalid mid-edit anyway (hand-edited YAML reaches the same state). A
		// box keyed on `p.name` throws `each_key_duplicate` in the PRODUCTION
		// build, not just dev, taking the canvas down beside a panel that
		// survives. Both box kinds are covered: `Contains` carries properties
		// here, so the association-class rule gives it a box too.
		const prop = MM.elements[0].properties[0];
		diagramView = {
			...DIAGRAM,
			mm: {
				...MM,
				elements: MM.elements.map((el) =>
					el.name === 'Zone' ? { ...el, properties: [prop, prop] } : el
				),
				relationships: MM.relationships.map((rel) => ({ ...rel, properties: [prop, prop] }))
			}
		};

		const c = mount(DiagramHost, { target: document.body });
		flushSync();

		expect(nodeByText('Zone')?.querySelectorAll('.mm-row')).toHaveLength(2);
		expect(nodeByText('Contains')?.querySelectorAll('.mm-row')).toHaveLength(2);

		unmount(c);
	});

	it('creates types with a name free across the WHOLE datatype space', () => {
		// The create-side twin of the rename guard: `addElementType` appends a
		// second same-named block that every later lookup resolves first-wins
		// past, and `addEnum` silently OVERWRITES (enums are a YAML mapping). So
		// a generated name must dodge the element types AND the enums, not just
		// its own section.
		diagramView = {
			...DIAGRAM,
			mm: { ...MM, enums: { ...MM.enums, NewType: ['a'], NewEnum: ['b'] } }
		};

		const c = mount(DiagramHost, { target: document.body });
		flushSync();

		findButton(/element type/i)!.click();
		flushSync();
		expect(applyDiagramEdit).toHaveBeenCalledWith({ kind: 'addElementType', name: 'NewType2' });

		findButton(/^\+ enum$/i)!.click();
		flushSync();
		expect(applyDiagramEdit).toHaveBeenCalledWith({
			kind: 'addEnum',
			name: 'NewEnum2',
			literals: []
		});

		unmount(c);
	});

	it('counts unattributed lint errors in the toolbar and sends the click to the YAML view', () => {
		// `errorNodeIds` is empty in every reachable state (see the state module:
		// a line-bearing lint error implies a buffer that does not parse, which
		// leaves nothing drawn to badge), so the COUNT is the whole error
		// surface — an error can never go unshown just because it has no home.
		diagramView = { ...DIAGRAM, unattributedErrorCount: 3 };

		const c = mount(DiagramHost, { target: document.body });
		flushSync();

		const badge = document.querySelector<HTMLButtonElement>('[data-testid="mm-issue-badge"]')!;
		expect(badge.textContent).toContain('3 issues');

		badge.click();
		flushSync();
		expect(setMetamodelView).toHaveBeenCalledWith('yaml');

		unmount(c);
	});

	it('shows no issue badge when the draft lints clean', () => {
		const c = mount(DiagramHost, { target: document.body });
		flushSync();

		expect(document.querySelector('[data-testid="mm-issue-badge"]')).toBeNull();

		unmount(c);
	});

	it('explains a read-only surface differently for an editor and a viewer', () => {
		editorView = { ...EDITOR, readOnly: true };
		role = 'editor';

		const c = mount(DiagramHost, { target: document.body });
		flushSync();
		// An editor may still rearrange: layout is presentation, and its gate is
		// separate from the owner-only buffer gate.
		expect(document.querySelector('[data-testid="mm-readonly-note"]')?.textContent).toContain(
			'rearrange'
		);
		unmount(c);

		role = 'viewer';
		const v = mount(DiagramHost, { target: document.body });
		flushSync();
		expect(document.querySelector('[data-testid="mm-readonly-note"]')?.textContent).toContain(
			'not saved'
		);
		unmount(v);
	});

	it('names the lease holder when a peer holds the metamodel', () => {
		editorView = { ...EDITOR, readOnly: true, lockedBy: 'peer@example.com' };

		const c = mount(DiagramHost, { target: document.body });
		flushSync();

		expect(document.querySelector('[data-testid="mm-readonly-note"]')?.textContent).toContain(
			'peer@example.com'
		);

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
