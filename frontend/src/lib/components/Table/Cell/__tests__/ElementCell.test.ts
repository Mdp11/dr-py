// The scope (element) cell renders the evaluate response's display_name —
// which goes stale the moment a rename is STAGED (uncommitted): value cells
// overlay staged property patches, so without the same overlay here the same
// name updates everywhere except the scope column. These tests pin the
// staged-name overlay. Same render convention as ValueCell.test.ts
// (mount/unmount/flushSync — @testing-library/svelte is not a dependency).
import { flushSync, mount, unmount } from 'svelte';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { TableCell } from '$lib/api/types';
import { server } from '$lib/api/__tests__/server';
import * as modelStore from '$lib/state/model.svelte';
import { engineStore, type EngineStore } from '$lib/state/__tests__/support/engine-store';
import ElementCell from '../ElementCell.svelte';
import ElementsCell from '../ElementsCell.svelte';

function elementCell(): Extract<TableCell, { kind: 'element' }> {
	return {
		kind: 'element',
		item: { id: 'e_000001', type_name: 'Organization', display_name: 'Old name', child_count: 0 }
	};
}

let store: EngineStore | null = null;

/** A real engine with `patch` staged on `e_000001`. */
async function stage(patch: Record<string, unknown>): Promise<void> {
	store = await engineStore();
	await modelStore.ensureElements(['e_000001']);
	modelStore.emit({ kind: 'update_element', id: 'e_000001', properties_patch: patch });
	await modelStore.stagedSettled();
}

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());
afterEach(() => {
	store?.dispose();
	store = null;
	modelStore.resetModelStore();
	document.body.innerHTML = '';
});

describe('ElementCell staged-name overlay', () => {
	it('renders the page display_name when nothing is staged', () => {
		const c = mount(ElementCell, { target: document.body, props: { cell: elementCell() } });
		flushSync();
		try {
			expect(document.body.textContent).toContain('Old name');
		} finally {
			unmount(c);
		}
	});

	it('shows a staged (uncommitted) rename instead of the stale display_name', async () => {
		await stage({ name: 'New name' });
		const c = mount(ElementCell, { target: document.body, props: { cell: elementCell() } });
		flushSync();
		try {
			expect(document.body.textContent).toContain('New name');
			expect(document.body.textContent).not.toContain('Old name');
		} finally {
			unmount(c);
		}
	});

	it('falls back to the element id when the staged edit clears the name', async () => {
		await stage({ name: null });
		const c = mount(ElementCell, { target: document.body, props: { cell: elementCell() } });
		flushSync();
		try {
			expect(document.body.textContent).toContain('e_000001');
			expect(document.body.textContent).not.toContain('Old name');
		} finally {
			unmount(c);
		}
	});

	it('ignores staged patches that do not touch the name', async () => {
		await stage({ description: 'changed' });
		const c = mount(ElementCell, { target: document.body, props: { cell: elementCell() } });
		flushSync();
		try {
			expect(document.body.textContent).toContain('Old name');
		} finally {
			unmount(c);
		}
	});
});

describe('ElementsCell staged-name overlay', () => {
	it('shows a staged rename on its element chips too', async () => {
		await stage({ name: 'New name' });
		const cell: Extract<TableCell, { kind: 'elements' }> = {
			kind: 'elements',
			items: [
				{ id: 'e_000001', type_name: 'Organization', display_name: 'Old name', child_count: 0 }
			],
			total: 1,
			truncated: false
		};
		const c = mount(ElementsCell, { target: document.body, props: { cell } });
		flushSync();
		try {
			expect(document.body.textContent).toContain('New name');
			expect(document.body.textContent).not.toContain('Old name');
		} finally {
			unmount(c);
		}
	});
});

describe('ElementCell reference editing', () => {
	// An element-typed PROPERTY column's cell: `element_id` is the OWNER (the
	// patch target), `item` the referenced element. Editable cells render the
	// Inspector's reference picker and stage the same `update_element` patch a
	// value cell does.
	function refCell(
		overrides: Partial<Extract<TableCell, { kind: 'element' }>> = {}
	): Extract<TableCell, { kind: 'element' }> {
		return {
			kind: 'element',
			item: { id: 'e1', type_name: 'Block', display_name: 'Old name', child_count: 0 },
			element_id: 'owner1',
			editable: true,
			ref_type: 'Block',
			...overrides
		};
	}

	it('renders a plain link, no picker, when the cell is not editable', () => {
		const c = mount(ElementCell, {
			target: document.body,
			props: { cell: refCell({ editable: false }), columnName: 'owner' }
		});
		flushSync();
		try {
			expect(document.body.textContent).not.toContain('Browse');
		} finally {
			unmount(c);
		}
	});

	it('clearing the reference stages a null property patch on the owner', async () => {
		const { setProjectInfo, resetCheckout } = await import('$lib/state');
		const gate = await import('$lib/state/edit-gate');
		resetCheckout();
		setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
		const ensureElement = vi
			.spyOn(modelStore, 'ensureElement')
			.mockResolvedValue({ id: 'owner1', type_name: 'Block', properties: {}, rev: 0 });
		vi.spyOn(gate, 'editLock').mockResolvedValue(true);
		const emit = vi.spyOn(modelStore, 'emit').mockImplementation(() => {});
		// The picker resolves the referenced element's name cache-or-fetch;
		// seed it so no request leaves the test.
		modelStore.seedElements([
			{ id: 'e1', type_name: 'Block', properties: { name: 'Old name' }, rev: 0 }
		]);
		const c = mount(ElementCell, {
			target: document.body,
			props: { cell: refCell(), columnName: 'owner' }
		});
		flushSync();
		try {
			expect(document.body.textContent).toContain('Browse');
			const clear = document.body.querySelector('button[aria-label="Clear reference"]');
			if (!clear) throw new Error('clear button not rendered');
			(clear as HTMLButtonElement).click();
			await new Promise((resolve) => setTimeout(resolve, 0));
			flushSync();
			expect(ensureElement).toHaveBeenCalledWith('owner1');
			expect(gate.editLock).toHaveBeenCalledWith('owner1');
			expect(emit).toHaveBeenCalledWith({
				kind: 'update_element',
				id: 'owner1',
				properties_patch: { owner: null }
			});
		} finally {
			unmount(c);
			resetCheckout();
			vi.restoreAllMocks();
		}
	});
});
