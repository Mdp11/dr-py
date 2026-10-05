import { flushSync, mount, unmount } from 'svelte';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';

import { stubEngine } from '../../api/__tests__/engine-stub';
import { installEngineSeam } from '../../api/engine-route';
import { resetModelStore, seedElements, setModelApiConfig } from '../../state/model.svelte';
import { seedRelationships } from '../../state/model.svelte';
import { clearSelection, select } from '../../state/selection.svelte';
import Inspector from '../Inspector.svelte';

const BASE = 'http://api.test/api/v1';

beforeAll(() => {
	setModelApiConfig({ baseUrl: BASE });
});
afterEach(() => {
	installEngineSeam(null);
	clearSelection();
});
afterAll(() => {
	setModelApiConfig(undefined);
});
beforeEach(() => {
	resetModelStore();
	clearSelection();
	stubEngine({ listElementRelationships: () => ({ items: [], total: 0 }) });
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
	// Seed the endpoints too: a relationship selection now renders source/target
	// navigation buttons, whose cache-or-fetch would otherwise ask the engine
	// (the stub answers only the relationships panel).
	seedElements([
		{ id: 'e1', type_name: 'Pump', properties: { name: 'P-101' }, rev: 1 },
		{ id: 'e2', type_name: 'Tank', properties: { name: 'T-9' }, rev: 1 }
	]);
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
