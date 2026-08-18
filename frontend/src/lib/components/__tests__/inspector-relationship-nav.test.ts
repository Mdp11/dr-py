// I-3 regression guard: a relationship selection must not be a navigational
// dead end.
//
// The Inspector's Relationships section is element-only, and the endpoint
// links that used to live in the (now deleted) DetailView went with it — so a
// user who landed on a relationship from an issue row had type + properties
// and no way to either endpoint. These tests pin the two endpoint buttons and
// the selection they hand off.
import { flushSync, mount, unmount } from 'svelte';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';

import { server } from '../../api/__tests__/server';
import {
	resetModelStore,
	seedElements,
	seedRelationships,
	setModelApiConfig
} from '../../state/model.svelte';
import { clearSelection, getSelection, select } from '../../state/selection.svelte';
import Inspector from '../Inspector.svelte';

const BASE = 'http://api.test/api/v1';

beforeAll(() => {
	server.listen({ onUnhandledRequest: 'error' });
	setModelApiConfig({ baseUrl: BASE });
});
afterEach(() => {
	server.resetHandlers();
	clearSelection();
});
afterAll(() => {
	setModelApiConfig(undefined);
	server.close();
});
beforeEach(() => {
	resetModelStore();
	clearSelection();
	server.use(
		http.get(`*/model/elements/:id/relationships`, () => HttpResponse.json({ items: [], total: 0 }))
	);
});

function button(testid: string): HTMLButtonElement {
	const node = document.body.querySelector(`[data-testid="${testid}"]`);
	if (node === null) throw new Error(`${testid} not rendered`);
	return node as HTMLButtonElement;
}

function selectRelationship() {
	seedElements([
		{ id: 'e1', type_name: 'Pump', properties: { name: 'P-101' }, rev: 1 },
		{ id: 'e2', type_name: 'Tank', properties: { name: 'T-9' }, rev: 1 }
	]);
	seedRelationships([
		{ id: 'r1', type_name: 'Feeds', source_id: 'e1', target_id: 'e2', properties: {}, rev: 1 }
	]);
	select({ kind: 'relationship', id: 'r1' });
	const component = mount(Inspector, { target: document.body });
	flushSync();
	return component;
}

it('labels the endpoints by name and navigates to the source', () => {
	const c = selectRelationship();
	try {
		expect(button('goto-source').textContent?.trim()).toBe('P-101');
		expect(button('goto-target').textContent?.trim()).toBe('T-9');
		// the raw id stays reachable as the title, since names are not unique
		expect(button('goto-source').title).toBe('e1');

		button('goto-source').click();
		flushSync();

		expect(getSelection()).toEqual({ kind: 'element', id: 'e1' });
	} finally {
		unmount(c);
	}
});

it('navigates to the target', () => {
	const c = selectRelationship();
	try {
		button('goto-target').click();
		flushSync();

		expect(getSelection()).toEqual({ kind: 'element', id: 'e2' });
	} finally {
		unmount(c);
	}
});

it('falls back to the endpoint id when the element has no name property', () => {
	seedElements([
		{ id: 'e1', type_name: 'Pump', properties: {}, rev: 1 },
		{ id: 'e2', type_name: 'Tank', properties: {}, rev: 1 }
	]);
	seedRelationships([
		{ id: 'r1', type_name: 'Feeds', source_id: 'e1', target_id: 'e2', properties: {}, rev: 1 }
	]);
	select({ kind: 'relationship', id: 'r1' });
	const c = mount(Inspector, { target: document.body });
	try {
		flushSync();
		expect(button('goto-source').textContent?.trim()).toBe('e1');
		expect(button('goto-target').textContent?.trim()).toBe('e2');
	} finally {
		unmount(c);
	}
});

it('renders no endpoint row for an element selection', () => {
	seedElements([{ id: 'e1', type_name: 'Pump', properties: { name: 'P-101' }, rev: 1 }]);
	select({ kind: 'element', id: 'e1' });
	const c = mount(Inspector, { target: document.body });
	try {
		flushSync();
		expect(document.body.querySelector('[data-testid="relationship-endpoints"]')).toBeNull();
	} finally {
		unmount(c);
	}
});
