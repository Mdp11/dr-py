import { flushSync, mount, unmount } from 'svelte';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';

import type { Element } from '$lib/api/types';
import { stubEngine } from '../../api/__tests__/engine-stub';
import { installEngineSeam } from '../../api/engine-route';
import { NotFoundError } from '../../api/errors';
import {
	emit,
	getCachedElements,
	resetModelStore,
	seedElements,
	setModelApiConfig
} from '../../state/model.svelte';
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
	// The engine still has the committed element (the delete is only staged);
	// the Inspector must neither resurrect it into the cache nor sit on the
	// loading skeleton forever.
	stubEngine({
		getElement: () => el('e1'),
		listElementRelationships: () => ({ items: [], total: 0 })
	});
	seedElements([el('e1')]);
	emit({ kind: 'delete_element', id: 'e1' });

	select({ kind: 'element', id: 'e1' });
	const component = mount(Inspector, { target: document.body });
	try {
		flushSync();
		await settle();
		flushSync();
		expect(document.querySelector('[data-testid="inspector-loading"]')).toBeNull();
		expect(document.body.textContent).toContain('Selection not found');
		expect(getCachedElements().has('e1')).toBe(false);
	} finally {
		unmount(component);
	}
});
