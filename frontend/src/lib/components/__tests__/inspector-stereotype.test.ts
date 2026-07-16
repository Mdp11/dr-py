import { flushSync, mount, unmount } from 'svelte';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';

import { server } from '../../api/__tests__/server';
import { resetModelStore, seedElements, setModelApiConfig } from '../../state/model.svelte';
import { seedRelationships } from '../../state/model.svelte';
import { clearSelection, select } from '../../state/selection.svelte';
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

it('shows the selected element stereotype (type_name) in the header', () => {
	seedElements([{ id: 'e1', type_name: 'Pump', properties: { name: 'P-101' }, rev: 1 }]);
	select({ kind: 'element', id: 'e1' });
	const component = mount(Inspector, { target: document.body });
	try {
		flushSync();
		const heading = document.querySelector('[data-testid="inspector-stereotype"]');
		expect(heading).not.toBeNull();
		expect(heading?.textContent?.trim()).toBe('Pump');
		expect(document.body.textContent).toContain('Element');
	} finally {
		unmount(component);
	}
});

it('shows the selected relationship stereotype in the header', () => {
	seedRelationships([
		{ id: 'r1', type_name: 'Feeds', source_id: 'e1', target_id: 'e2', properties: {}, rev: 1 }
	]);
	select({ kind: 'relationship', id: 'r1' });
	const component = mount(Inspector, { target: document.body });
	try {
		flushSync();
		const heading = document.querySelector('[data-testid="inspector-stereotype"]');
		expect(heading?.textContent?.trim()).toBe('Feeds');
		expect(document.body.textContent).toContain('Relationship');
	} finally {
		unmount(component);
	}
});
