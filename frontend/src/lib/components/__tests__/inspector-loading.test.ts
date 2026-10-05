import { flushSync, mount, unmount } from 'svelte';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';

import type { Element } from '$lib/api/types';
import { stubEngine } from '../../api/__tests__/engine-stub';
import { installEngineSeam } from '../../api/engine-route';
import { NotFoundError } from '../../api/errors';
import {
	emit,
	ensureElements,
	getCachedElements,
	resetModelStore,
	setModelApiConfig,
	stagedSettled
} from '../../state/model.svelte';
import { server } from '../../api/__tests__/server';
import { engineStore } from '../../state/__tests__/support/engine-store';
import { clearSelection, select } from '../../state/selection.svelte';
import Inspector from '../Inspector.svelte';

const BASE = 'http://api.test/api/v1';

beforeAll(() => {
	server.listen({ onUnhandledRequest: 'error' });
	setModelApiConfig({ baseUrl: BASE });
});
afterEach(() => {
	installEngineSeam(null);
	clearSelection();
});
afterAll(() => {
	setModelApiConfig(undefined);
	server.close();
});
beforeEach(() => {
	resetModelStore();
	clearSelection();
});

function el(id: string): Element {
	return { id, type_name: 'Block', properties: { Name: 'Pump' }, rev: 1 };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

it('shows a loading skeleton (not "Selection not found") while the element fetch is in flight', async () => {
	let answer!: () => void;
	const held = new Promise<void>((resolve) => (answer = resolve));
	stubEngine({
		getElement: async () => {
			await held;
			return el('e1');
		},
		listElementRelationships: () => ({ items: [], total: 0 })
	});

	select({ kind: 'element', id: 'e1' });
	const component = mount(Inspector, { target: document.body });
	try {
		flushSync();
		// while the fetch is pending: skeleton, and NO "not found" flash
		expect(document.querySelector('[data-testid="inspector-loading"]')).not.toBeNull();
		expect(document.body.textContent).not.toContain('Selection not found');

		answer();
		await settle();
		flushSync();
		expect(document.querySelector('[data-testid="inspector-loading"]')).toBeNull();
		expect(document.body.textContent).toContain('Properties');
	} finally {
		unmount(component);
	}
});

it('shows "Selection not found" once the engine confirms the id is missing', async () => {
	stubEngine({
		getElement: () => {
			throw new NotFoundError(404, { detail: 'nope' }, 'nope');
		},
		listElementRelationships: () => ({ items: [], total: 0 })
	});

	select({ kind: 'element', id: 'ghost' });
	const component = mount(Inspector, { target: document.body });
	try {
		flushSync();
		expect(document.querySelector('[data-testid="inspector-loading"]')).not.toBeNull();

		await settle();
		flushSync();
		expect(document.querySelector('[data-testid="inspector-loading"]')).toBeNull();
		expect(document.body.textContent).toContain('Selection not found');
	} finally {
		unmount(component);
	}
});

it('renders "Selection not found" for a staged-deleted element instead of refetching it', async () => {
	// The delete is only staged; the Inspector must neither resurrect the
	// element into the cache nor sit on the loading skeleton forever.
	const store = await engineStore();
	await ensureElements(['e_000001']);
	emit({ kind: 'delete_element', id: 'e_000001' });
	await stagedSettled();

	select({ kind: 'element', id: 'e_000001' });
	const component = mount(Inspector, { target: document.body });
	try {
		flushSync();
		await settle();
		flushSync();
		expect(document.querySelector('[data-testid="inspector-loading"]')).toBeNull();
		expect(document.body.textContent).toContain('Selection not found');
		expect(getCachedElements().has('e_000001')).toBe(false);
	} finally {
		unmount(component);
		store.dispose();
	}
});
