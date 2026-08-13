import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { Metamodel } from '$lib/api/types';
import { FIXTURE } from '$lib/metamodel/__tests__/fixtures';
import { parseDraft } from '$lib/metamodel/yaml-edit';

/**
 * Relationship/enum forms, the delete-consequence dialog and the connection
 * popover (Task 12). Same shape as `MetamodelForms.test.ts`: the state module
 * is mocked, and what is asserted is the COMMAND each gesture emits.
 *
 * The popover is mounted DIRECTLY rather than driven through a drag on the
 * canvas: Svelte Flow's connection gesture needs measured handles, and
 * happy-dom reports every element as 0x0 (see MetamodelDiagram.test.ts). The
 * canvas's job is only to turn two node ids into this component's two props.
 */

const MM: Metamodel = parseDraft(FIXTURE).mm!;

vi.mock('$lib/state', async (orig) => {
	const actual = await orig<typeof import('$lib/state')>();
	return {
		...actual,
		applyDiagramEdit: vi.fn(() => true),
		selectDiagramNode: vi.fn()
	};
});

// Imported AFTER the factory so these are the mocked bindings.
import { applyDiagramEdit, selectDiagramNode } from '$lib/state';
import ConnectionPopover from '../Metamodel/diagram/ConnectionPopover.svelte';
import DeleteTypeDialog from '../Metamodel/forms/DeleteTypeDialog.svelte';
import EnumForm from '../Metamodel/forms/EnumForm.svelte';
import RelationshipTypeForm from '../Metamodel/forms/RelationshipTypeForm.svelte';

function byId<T extends HTMLElement>(testid: string): T {
	const el = document.querySelector<T>(`[data-testid="${testid}"]`);
	if (el === null) throw new Error(`no element with data-testid="${testid}"`);
	return el;
}

function allById<T extends HTMLElement>(testid: string): T[] {
	return [...document.querySelectorAll<T>(`[data-testid="${testid}"]`)];
}

function fire(el: HTMLElement, type: string): void {
	el.dispatchEvent(new Event(type, { bubbles: type !== 'blur' }));
	flushSync();
}

/** bits-ui defers Content mount past a requestAnimationFrame, which
 * flushSync() alone does not drive — mirrors ConfirmHost.test.ts's helper. */
async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > deadline) throw new Error('waitFor timed out');
		await new Promise((r) => setTimeout(r, 10));
		flushSync();
	}
}

beforeEach(() => {
	document.body.innerHTML = '';
	vi.clearAllMocks();
});

afterEach(() => {
	document.body.innerHTML = '';
});

describe('RelationshipTypeForm', () => {
	function mountForm(name: string, readOnly = false): ReturnType<typeof mount> {
		const c = mount(RelationshipTypeForm, {
			target: document.body,
			props: { mm: MM, name, readOnly, onRequestDelete: () => {} }
		});
		flushSync();
		return c;
	}

	it('toggles containment', () => {
		const c = mountForm('Monitors');

		const cb = byId<HTMLInputElement>('mm-rel-containment');
		cb.checked = true;
		fire(cb, 'change');

		expect(applyDiagramEdit).toHaveBeenCalledWith({
			kind: 'setRelationshipContainment',
			name: 'Monitors',
			value: true
		});

		unmount(c);
	});

	it('refuses a rename onto another relationship type, but not onto an element type', () => {
		const c = mountForm('Contains');
		const input = byId<HTMLInputElement>('mm-rel-name');

		input.value = 'Monitors';
		fire(input, 'blur');
		expect(applyDiagramEdit).not.toHaveBeenCalled();
		expect(byId('mm-rel-name-error').textContent).toContain('relationship type');

		// `Zone` is an ELEMENT type, and relationship types have their own name
		// space — refusing this would block a valid edit.
		input.value = 'Zone';
		fire(input, 'blur');
		expect(applyDiagramEdit).toHaveBeenCalledWith({
			kind: 'renameRelationshipType',
			from: 'Contains',
			to: 'Zone'
		});

		unmount(c);
	});

	it('removes a mapping by its exact pair', () => {
		const c = mountForm('Contains');

		expect(allById('mm-map-row')).toHaveLength(1);
		byId('mm-map-remove').click();
		flushSync();

		expect(applyDiagramEdit).toHaveBeenCalledWith({
			kind: 'removeMapping',
			name: 'Contains',
			mapping: { source: 'Zone', target: 'Building' }
		});

		unmount(c);
	});

	it('commits an end multiplicity on blur', () => {
		const c = mountForm('Contains');

		const input = byId<HTMLInputElement>('mm-rel-target-mult');
		input.value = '1..2';
		fire(input, 'blur');

		expect(applyDiagramEdit).toHaveBeenCalledWith({
			kind: 'setEndMultiplicity',
			name: 'Contains',
			end: 'target',
			value: '1..2'
		});

		unmount(c);
	});

	it('hides every mutating affordance when read-only', () => {
		const c = mountForm('Contains', true);

		expect(byId<HTMLInputElement>('mm-rel-name').disabled).toBe(true);
		expect(document.querySelector('[data-testid="mm-map-remove"]')).toBeNull();
		expect(document.querySelector('[data-testid="mm-map-add"]')).toBeNull();
		expect(document.querySelector('[data-testid="mm-rel-delete"]')).toBeNull();

		unmount(c);
	});
});

describe('EnumForm', () => {
	it('commits an edited literal as the full list', () => {
		const c = mount(EnumForm, {
			target: document.body,
			props: { mm: MM, name: 'Status', readOnly: false, onRequestDelete: () => {} }
		});
		flushSync();

		const inputs = allById<HTMLInputElement>('mm-enum-literal');
		expect(inputs.map((i) => i.value)).toEqual(['Draft', 'Active']);

		inputs[0].value = 'Proposed';
		fire(inputs[0], 'blur');

		expect(applyDiagramEdit).toHaveBeenCalledWith({
			kind: 'setEnumLiterals',
			name: 'Status',
			literals: ['Proposed', 'Active']
		});

		unmount(c);
	});

	it('refuses a rename onto an element type name', () => {
		// Enums share the datatype space with element types. A duplicate is worse
		// here than a first-wins lookup: `enums` is a YAML MAPPING, so a second
		// key of the same name stops the draft parsing at all.
		const c = mount(EnumForm, {
			target: document.body,
			props: { mm: MM, name: 'Status', readOnly: false, onRequestDelete: () => {} }
		});
		flushSync();

		const input = byId<HTMLInputElement>('mm-enum-name');
		input.value = 'Zone';
		fire(input, 'blur');

		expect(applyDiagramEdit).not.toHaveBeenCalled();
		expect(byId('mm-enum-name-error').textContent).toContain('element type');
		expect(input.value).toBe('Zone');

		unmount(c);
	});

	it('reorders a literal without changing the rest', () => {
		const c = mount(EnumForm, {
			target: document.body,
			props: { mm: MM, name: 'Status', readOnly: false, onRequestDelete: () => {} }
		});
		flushSync();

		allById('mm-enum-literal-down')[0].click();
		flushSync();

		expect(applyDiagramEdit).toHaveBeenCalledWith({
			kind: 'setEnumLiterals',
			name: 'Status',
			literals: ['Active', 'Draft']
		});

		unmount(c);
	});
});

describe('DeleteTypeDialog', () => {
	it('lists the auto-fixed consequences and removes the type on confirm', async () => {
		const c = mount(DeleteTypeDialog, {
			target: document.body,
			props: {
				sel: { kind: 'element', name: 'Building' },
				mm: MM,
				onConfirm: () => {},
				onCancel: () => {}
			}
		});
		flushSync();
		await waitFor(() => document.querySelector('[data-testid="mm-delete-dialog"]') !== null);

		const updated = byId('mm-delete-updated');
		expect(updated.textContent).toContain('Contains');
		expect(updated.textContent).toContain('Zone → Building');

		byId('mm-delete-confirm').click();
		flushSync();

		expect(applyDiagramEdit).toHaveBeenCalledWith({
			kind: 'removeElementType',
			name: 'Building'
		});

		unmount(c);
	});

	it('lists what a relationship delete leaves dangling', async () => {
		const c = mount(DeleteTypeDialog, {
			target: document.body,
			props: {
				sel: { kind: 'relationship', name: 'Observes' },
				mm: MM,
				onConfirm: () => {},
				onCancel: () => {}
			}
		});
		flushSync();
		await waitFor(() => document.querySelector('[data-testid="mm-delete-dialog"]') !== null);

		// `Monitors extends Observes` — the cascade clears that pointer for us.
		expect(byId('mm-delete-updated').textContent).toContain('Monitors');

		unmount(c);
	});
});

describe('ConnectionPopover', () => {
	it('creates a relationship type carrying the drawn pair', () => {
		const c = mount(ConnectionPopover, {
			target: document.body,
			props: { mm: MM, source: 'Zone', target: 'Building', onclose: () => {} }
		});
		flushSync();

		byId('mm-conn-create').click();
		flushSync();

		expect(applyDiagramEdit).toHaveBeenCalledWith({
			kind: 'addRelationshipType',
			name: 'Relates',
			containment: false,
			mapping: { source: 'Zone', target: 'Building' }
		});
		expect(selectDiagramNode).toHaveBeenCalledWith({ kind: 'relationship', name: 'Relates' });

		unmount(c);
	});

	it('refuses to create a relationship type whose name is taken', () => {
		// The default name is generated free, but the field is free TEXT — the one
		// create path a user can type into must run the same guard.
		const c = mount(ConnectionPopover, {
			target: document.body,
			props: { mm: MM, source: 'Zone', target: 'Building', onclose: () => {} }
		});
		flushSync();

		const input = byId<HTMLInputElement>('mm-conn-name');
		input.value = 'Contains';
		fire(input, 'input');
		byId('mm-conn-create').click();
		flushSync();

		expect(applyDiagramEdit).not.toHaveBeenCalled();
		expect(byId('mm-conn-name-error').textContent).toContain('relationship type');

		unmount(c);
	});

	it('adds a mapping to an existing relationship type', () => {
		const c = mount(ConnectionPopover, {
			target: document.body,
			props: { mm: MM, source: 'Zone', target: 'Building', onclose: () => {} }
		});
		flushSync();

		const select = byId<HTMLSelectElement>('mm-conn-existing');
		select.value = 'Monitors';
		fire(select, 'change');
		byId('mm-conn-add-mapping').click();
		flushSync();

		expect(applyDiagramEdit).toHaveBeenCalledWith({
			kind: 'addMapping',
			name: 'Monitors',
			mapping: { source: 'Zone', target: 'Building' }
		});

		unmount(c);
	});

	it('offers "set extends" only when it cannot cycle', () => {
		const ok = mount(ConnectionPopover, {
			target: document.body,
			props: { mm: MM, source: 'Zone', target: 'Building', onclose: () => {} }
		});
		flushSync();
		expect(document.querySelector('[data-testid="mm-conn-extends"]')).not.toBeNull();
		unmount(ok);

		// Zone already descends from NamedElement, so `NamedElement extends Zone`
		// would close the loop — the option must not be offered at all.
		const cyclic = mount(ConnectionPopover, {
			target: document.body,
			props: { mm: MM, source: 'NamedElement', target: 'Zone', onclose: () => {} }
		});
		flushSync();
		expect(document.querySelector('[data-testid="mm-conn-extends"]')).toBeNull();
		unmount(cyclic);
	});
});
