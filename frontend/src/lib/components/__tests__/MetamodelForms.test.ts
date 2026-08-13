import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { Metamodel } from '$lib/api/types';
import { FIXTURE } from '$lib/metamodel/__tests__/fixtures';
import { parseDraft } from '$lib/metamodel/yaml-edit';
import type { MetamodelDiagramView } from '$lib/state';

/**
 * Form-panel tests (Task 11). The state module is mocked wholesale, so what
 * these assert is the CONTRACT between a form control and the command it
 * emits: one `YamlEditCommand` per field change, carrying the full shape the
 * yaml-edit handler expects. Task 2-4's suites already prove what each command
 * does to the YAML; nothing here re-derives that.
 *
 * The metamodel under test is parsed from the SHARED yaml fixture rather than
 * hand-built, so the forms are exercised against exactly the shapes the
 * yaml-edit suites use (abstract root + two subtypes, a mapless abstract
 * relationship, shorthand endpoints).
 */

const MM: Metamodel = parseDraft(FIXTURE).mm!;

const BASE_VIEW: MetamodelDiagramView = {
	view: 'diagram',
	mm: MM,
	parseErrors: [],
	selection: null,
	positions: {},
	collapsed: new Set(),
	canUndo: false,
	errorNodeIds: new Set(),
	unattributedErrorCount: 0
};

/** Only the panel reads the view getter; the forms below take explicit props. */
let panelView: MetamodelDiagramView = BASE_VIEW;

vi.mock('$lib/state', async (orig) => {
	const actual = await orig<typeof import('$lib/state')>();
	return {
		...actual,
		applyDiagramEdit: vi.fn(() => true),
		selectDiagramNode: vi.fn(),
		getMetamodelDiagramView: vi.fn(() => panelView)
	};
});

// Imported AFTER the factory so these are the mocked bindings.
import { applyDiagramEdit, selectDiagramNode } from '$lib/state';
import ElementTypeForm from '../Metamodel/forms/ElementTypeForm.svelte';
import KeyBuilder from '../Metamodel/forms/KeyBuilder.svelte';
import MetamodelFormPanel from '../Metamodel/forms/MetamodelFormPanel.svelte';
import PropertyListEditor from '../Metamodel/forms/PropertyListEditor.svelte';

function byId<T extends HTMLElement>(testid: string): T {
	const el = document.querySelector<T>(`[data-testid="${testid}"]`);
	if (el === null) throw new Error(`no element with data-testid="${testid}"`);
	return el;
}

function allById<T extends HTMLElement>(testid: string): T[] {
	return [...document.querySelectorAll<T>(`[data-testid="${testid}"]`)];
}

/** `change`/`click` are delegated by Svelte 5, so they must bubble to reach
 * the handler; `blur` is bound directly to the element and does not. */
function fire(el: HTMLElement, type: string): void {
	el.dispatchEvent(new Event(type, { bubbles: type !== 'blur' }));
	flushSync();
}

beforeEach(() => {
	panelView = BASE_VIEW;
	document.body.innerHTML = '';
	vi.clearAllMocks();
});

afterEach(() => {
	document.body.innerHTML = '';
});

describe('MetamodelFormPanel', () => {
	it('lists enums and mapless relationship types, and selects the one clicked', () => {
		const c = mount(MetamodelFormPanel, {
			target: document.body,
			props: { readOnly: false }
		});
		flushSync();

		const overview = byId('mm-panel-overview');
		expect(overview.textContent).toContain('3 element types');
		// `Observes` is abstract with no mappings: no edge anchors it, so this
		// list is the only way to reach its form.
		expect(overview.textContent).toContain('Observes');
		expect(overview.textContent).not.toContain('Contains');

		[...overview.querySelectorAll('button')]
			.find((b) => (b.textContent ?? '').includes('Status'))!
			.click();
		flushSync();

		expect(selectDiagramNode).toHaveBeenCalledWith({ kind: 'enum', name: 'Status' });

		unmount(c);
	});

	it('says why the fields are inert on a read-only surface', () => {
		const c = mount(MetamodelFormPanel, {
			target: document.body,
			props: { readOnly: true }
		});
		flushSync();

		// The panel scrolls away from the toolbar that carries the reason, so it
		// repeats the fact locally rather than showing unexplained dead controls.
		expect(byId('mm-panel-readonly').textContent).toContain('Read-only');

		unmount(c);
	});

	it('dispatches to the element form for an element selection', () => {
		panelView = { ...BASE_VIEW, selection: { kind: 'element', name: 'Zone' } };

		const c = mount(MetamodelFormPanel, {
			target: document.body,
			props: { readOnly: false }
		});
		flushSync();

		expect(document.querySelector('[data-testid="mm-panel-overview"]')).toBeNull();
		expect(byId<HTMLInputElement>('mm-form-name').value).toBe('Zone');

		unmount(c);
	});
});

describe('ElementTypeForm', () => {
	it('renames on blur, and re-points the selection at the new name', () => {
		const c = mount(ElementTypeForm, {
			target: document.body,
			props: { mm: MM, name: 'Zone', readOnly: false, onRequestDelete: () => {} }
		});
		flushSync();

		const input = byId<HTMLInputElement>('mm-form-name');
		input.value = 'District';
		fire(input, 'blur');

		expect(applyDiagramEdit).toHaveBeenCalledWith({
			kind: 'renameElementType',
			from: 'Zone',
			to: 'District'
		});
		// Without this the panel would keep pointing at a name the draft no
		// longer defines and blank itself out mid-rename.
		expect(selectDiagramNode).toHaveBeenCalledWith({ kind: 'element', name: 'District' });

		unmount(c);
	});

	it('refuses a rename onto a name the datatype space already holds', () => {
		const c = mount(ElementTypeForm, {
			target: document.body,
			props: { mm: MM, name: 'Zone', readOnly: false, onRequestDelete: () => {} }
		});
		flushSync();

		const input = byId<HTMLInputElement>('mm-form-name');

		// Another element type. Nothing downstream would report this: `typeMap`
		// resolves first-wins, and so does the backend's own cache — there is no
		// duplicate check in `check_metamodel` — so every later edit to "Building"
		// would silently rewrite the other one.
		input.value = 'Building';
		fire(input, 'blur');
		expect(applyDiagramEdit).not.toHaveBeenCalled();
		expect(byId('mm-form-name-error').textContent).toContain('element type');

		// An ENUM: the same space, because both are things a `datatype` can name.
		input.value = 'Status';
		fire(input, 'blur');
		expect(applyDiagramEdit).not.toHaveBeenCalled();
		expect(byId('mm-form-name-error').textContent).toContain('enum');

		// A primitive, which the loader reserves.
		input.value = 'date';
		fire(input, 'blur');
		expect(applyDiagramEdit).not.toHaveBeenCalled();
		expect(byId('mm-form-name-error').textContent).toContain('built-in');

		unmount(c);
	});

	it('allows a rename onto a RELATIONSHIP type name — a separate space', () => {
		// Guarding across all three would block a valid edit: `check_metamodel`
		// has no element∩relationship rule, and `TypeRef` exists because the two
		// sections are addressed separately.
		const c = mount(ElementTypeForm, {
			target: document.body,
			props: { mm: MM, name: 'Zone', readOnly: false, onRequestDelete: () => {} }
		});
		flushSync();

		const input = byId<HTMLInputElement>('mm-form-name');
		input.value = 'Monitors';
		fire(input, 'blur');

		expect(applyDiagramEdit).toHaveBeenCalledWith({
			kind: 'renameElementType',
			from: 'Zone',
			to: 'Monitors'
		});
		expect(document.querySelector('[data-testid="mm-form-name-error"]')).toBeNull();

		unmount(c);
	});

	it('offers only extends targets that cannot cycle', () => {
		const c = mount(ElementTypeForm, {
			target: document.body,
			props: { mm: MM, name: 'NamedElement', readOnly: false, onRequestDelete: () => {} }
		});
		flushSync();

		const options = [...byId<HTMLSelectElement>('mm-form-extends').options].map((o) => o.value);
		// Self and every descendant are excluded — Zone and Building both extend
		// NamedElement, so nothing but the null option is left.
		expect(options).not.toContain('NamedElement');
		expect(options).not.toContain('Zone');
		expect(options).not.toContain('Building');
		expect(options).toEqual(['']);

		unmount(c);
	});

	it('disables every control and hides the add/remove affordances when read-only', () => {
		const c = mount(ElementTypeForm, {
			target: document.body,
			props: { mm: MM, name: 'Zone', readOnly: true, onRequestDelete: () => {} }
		});
		flushSync();

		expect(byId<HTMLInputElement>('mm-form-name').disabled).toBe(true);
		expect(byId<HTMLInputElement>('mm-form-abstract').disabled).toBe(true);
		expect(byId<HTMLSelectElement>('mm-form-extends').disabled).toBe(true);
		expect(document.querySelector('[data-testid="mm-form-delete"]')).toBeNull();
		expect(document.querySelector('[data-testid="mm-prop-add"]')).toBeNull();
		expect(document.querySelector('[data-testid="mm-prop-remove"]')).toBeNull();
		expect(document.querySelector('[data-testid="mm-key-add-prop"]')).toBeNull();
		expect(document.querySelector('[data-testid="mm-key-add-rel"]')).toBeNull();

		unmount(c);
	});
});

describe('PropertyListEditor', () => {
	const owner = { kind: 'element', name: 'Zone' } as const;

	it('adds a property with the default definition', () => {
		const c = mount(PropertyListEditor, {
			target: document.body,
			props: { mm: MM, owner, readOnly: false }
		});
		flushSync();

		byId('mm-prop-add').click();
		flushSync();

		expect(applyDiagramEdit).toHaveBeenCalledWith({
			kind: 'addProperty',
			owner,
			prop: {
				name: 'new_property',
				datatype: 'string',
				multiplicity: '0..1',
				min: null,
				max: null,
				pattern: null,
				max_length: null
			}
		});

		unmount(c);
	});

	it('emits the FULL definition when one field changes', () => {
		const c = mount(PropertyListEditor, {
			target: document.body,
			props: { mm: MM, owner, readOnly: false }
		});
		flushSync();

		// The row is collapsed to `name — datatype — mult` until it is opened.
		byId('mm-prop-row').click();
		flushSync();

		const select = byId<HTMLSelectElement>('mm-prop-datatype');
		select.value = 'string';
		fire(select, 'change');

		expect(applyDiagramEdit).toHaveBeenCalledWith({
			kind: 'updateProperty',
			owner,
			propName: 'area',
			prop: {
				name: 'area',
				datatype: 'string',
				multiplicity: '0..1',
				// The untouched facets ride along: `updateProperty` REPLACES the row.
				min: 0,
				max: null,
				pattern: null,
				max_length: null
			}
		});

		unmount(c);
	});

	it('picks a free default name so a second add cannot shadow the first', () => {
		// `updateProperty`/`removeProperty` address a row by FIRST NAME MATCH, so
		// two `new_property` rows would make every later edit to the second
		// silently rewrite the first. The add button closes that door.
		const withDefault: Metamodel = {
			...MM,
			elements: MM.elements.map((e) =>
				e.name === 'Zone' ? { ...e, properties: [{ ...e.properties[0], name: 'new_property' }] } : e
			)
		};

		const c = mount(PropertyListEditor, {
			target: document.body,
			props: { mm: withDefault, owner, readOnly: false }
		});
		flushSync();

		byId('mm-prop-add').click();
		flushSync();

		expect(applyDiagramEdit).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'addProperty',
				prop: expect.objectContaining({ name: 'new_property2' })
			})
		);

		unmount(c);
	});

	it('refuses a rename onto a sibling property name, with an inline error', () => {
		// The other door to the same first-name-match corruption: rename `area` to
		// `size` and every later edit to `size` would hit `area` instead.
		const twoProps: Metamodel = {
			...MM,
			elements: MM.elements.map((e) =>
				e.name === 'Zone'
					? { ...e, properties: [e.properties[0], { ...e.properties[0], name: 'size' }] }
					: e
			)
		};

		const c = mount(PropertyListEditor, {
			target: document.body,
			props: { mm: twoProps, owner, readOnly: false }
		});
		flushSync();
		allById('mm-prop-row')[0].click();
		flushSync();

		const input = byId<HTMLInputElement>('mm-prop-name');
		input.value = 'size';
		fire(input, 'blur');

		expect(applyDiagramEdit).not.toHaveBeenCalled();
		expect(byId('mm-prop-name-error').textContent).toContain('size');
		// The typed text stays put: this is a correctable validation error, not a
		// rejected command.
		expect(input.value).toBe('size');

		unmount(c);
	});

	it('survives duplicate property names', () => {
		// Two clicks of "+ Property" produce two rows called `new_property`, and a
		// draft is allowed to be invalid mid-edit — so the row list must not key
		// on the name alone, or Svelte throws `each_key_duplicate` and the whole
		// panel dies on a state the user reaches in two clicks.
		const dup: Metamodel = {
			...MM,
			elements: MM.elements.map((e) =>
				e.name === 'Zone' ? { ...e, properties: [e.properties[0], e.properties[0]] } : e
			)
		};

		const c = mount(PropertyListEditor, {
			target: document.body,
			props: { mm: dup, owner, readOnly: false }
		});
		flushSync();

		expect(allById('mm-prop-row')).toHaveLength(2);

		unmount(c);
	});

	it('groups the datatype options into primitives, enums and element types', () => {
		const c = mount(PropertyListEditor, {
			target: document.body,
			props: { mm: MM, owner, readOnly: false }
		});
		flushSync();
		byId('mm-prop-row').click();
		flushSync();

		const groups = [...byId<HTMLSelectElement>('mm-prop-datatype').querySelectorAll('optgroup')];
		expect(groups.map((g) => g.label)).toEqual(['Primitives', 'Enums', 'Element types']);
		expect([...groups[1].querySelectorAll('option')].map((o) => o.value)).toEqual(['Status']);

		unmount(c);
	});
});

describe('KeyBuilder', () => {
	it('appends a relationship entry as one full-array setElementKey', () => {
		const c = mount(KeyBuilder, {
			target: document.body,
			props: { mm: MM, name: 'NamedElement', readOnly: false }
		});
		flushSync();

		byId('mm-key-add-rel').click();
		flushSync();

		// Abstract relationship types are not offered: a key entry resolves to a
		// relationship END, and an abstract type has no instances to key on.
		expect(applyDiagramEdit).toHaveBeenCalledWith({
			kind: 'setElementKey',
			name: 'NamedElement',
			key: ['name', 'out:Contains']
		});

		unmount(c);
	});

	it('renders one row per entry and clears the whole key to null', () => {
		const c = mount(KeyBuilder, {
			target: document.body,
			props: { mm: MM, name: 'NamedElement', readOnly: false }
		});
		flushSync();

		expect(allById('mm-key-entry')).toHaveLength(1);

		byId('mm-key-clear').click();
		flushSync();

		expect(applyDiagramEdit).toHaveBeenCalledWith({
			kind: 'setElementKey',
			name: 'NamedElement',
			key: null
		});

		unmount(c);
	});
});
