import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import {
	clearSelection,
	emit,
	getCachedElements,
	getSelection,
	getStagedDepth,
	resetModelStore,
	seedElements
} from '$lib/state';
import { createTempId } from '$lib/state/ops';
import StagedSection from '../Sidebar/StagedSection.svelte';

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

function mountSection(): void {
	app = mount(StagedSection, { target: host });
	flushSync();
}

beforeEach(() => {
	resetModelStore();
	clearSelection();
	localStorage.clear();
	host = document.createElement('div');
	document.body.appendChild(host);
});

afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
});

describe('StagedSection', () => {
	it('renders nothing when no ops are staged', () => {
		mountSection();
		expect(host.querySelector('[data-testid="staged-section"]')).toBeNull();
	});

	it('lists staged elements with status badges and a count', () => {
		seedElements([
			{ id: 'e1', type_name: 'Device', properties: { name: 'Edited one' }, rev: 1 },
			{ id: 'e2', type_name: 'Device', properties: { name: 'Doomed' }, rev: 1 }
		]);
		const tmp = createTempId();
		emit({
			kind: 'create_element',
			temp_id: tmp,
			type_name: 'Device',
			properties: { name: 'Fresh' }
		});
		emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'Edited two' } });
		emit({ kind: 'delete_element', id: 'e2' });
		mountSection();
		expect(host.textContent).toContain('Staged elements');
		expect(host.textContent).toContain('3');
		expect(host.querySelector(`[data-staged-id="${tmp}"]`)?.getAttribute('data-status')).toBe(
			'new'
		);
		expect(host.querySelector('[data-staged-id="e1"]')?.getAttribute('data-status')).toBe(
			'modified'
		);
		expect(host.querySelector('[data-staged-id="e2"]')?.getAttribute('data-status')).toBe(
			'deleted'
		);
		expect(host.textContent).toContain('Fresh');
		expect(host.textContent).toContain('Edited two');
		expect(host.textContent).toContain('Doomed'); // name from journal pre-state
	});

	it('clicking a row selects the element; deleted rows have no select button', () => {
		seedElements([{ id: 'e2', type_name: 'Device', properties: { name: 'Doomed' }, rev: 1 }]);
		const tmp = createTempId();
		emit({
			kind: 'create_element',
			temp_id: tmp,
			type_name: 'Device',
			properties: { name: 'Fresh' }
		});
		emit({ kind: 'delete_element', id: 'e2' });
		mountSection();
		const newRow = host.querySelector(`[data-staged-id="${tmp}"]`)!;
		(newRow.querySelector('button.staged-select') as HTMLButtonElement).click();
		flushSync();
		expect(getSelection()).toEqual({ kind: 'element', id: tmp });
		const deletedRow = host.querySelector('[data-staged-id="e2"]')!;
		expect(deletedRow.querySelector('button.staged-select')).toBeNull();
	});

	it('revert un-creates a new element, clears its selection, and hides the empty section', () => {
		const tmp = createTempId();
		emit({
			kind: 'create_element',
			temp_id: tmp,
			type_name: 'Device',
			properties: { name: 'Fresh' }
		});
		mountSection();
		(
			host.querySelector(`[data-staged-id="${tmp}"] button.staged-select`) as HTMLButtonElement
		).click();
		flushSync();
		(host.querySelector('[data-testid="staged-revert"]') as HTMLButtonElement).click();
		flushSync();
		expect(getStagedDepth()).toBe(0);
		expect(getCachedElements().has(tmp)).toBe(false);
		expect(getSelection()).toBeNull();
		expect(host.querySelector('[data-testid="staged-section"]')).toBeNull();
	});

	it('revert on a modified element keeps the selection', () => {
		seedElements([{ id: 'e1', type_name: 'Device', properties: { name: 'a' }, rev: 1 }]);
		emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'b' } });
		mountSection();
		(host.querySelector('[data-staged-id="e1"] button.staged-select') as HTMLButtonElement).click();
		flushSync();
		(host.querySelector('[data-testid="staged-revert"]') as HTMLButtonElement).click();
		flushSync();
		expect(getCachedElements().get('e1')?.properties.name).toBe('a');
		expect(getSelection()).toEqual({ kind: 'element', id: 'e1' });
	});

	it('header toggle collapses the row list', () => {
		const tmp = createTempId();
		emit({
			kind: 'create_element',
			temp_id: tmp,
			type_name: 'Device',
			properties: { name: 'Fresh' }
		});
		mountSection();
		expect(host.querySelector(`[data-staged-id="${tmp}"]`)).not.toBeNull();
		(host.querySelector('[data-testid="staged-header"]') as HTMLButtonElement).click();
		flushSync();
		expect(host.querySelector(`[data-staged-id="${tmp}"]`)).toBeNull();
		expect(localStorage.getItem('ui.stagedSectionCollapsed')).toBe('true');
	});
});
