// C-1 regression guard: element deletion has to have a UI trigger.
//
// The Delete affordance used to live in the (now deleted) DetailView tab; it
// was re-homed into the Inspector beside the LockControl. Nothing covered the
// old one, which is exactly how the whole capability vanished unnoticed when
// DetailView was removed — so this file pins the FLOW (confirm → delete lease
// → staged op), not just the button's presence.
import { flushSync, mount, unmount } from 'svelte';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import type { Element, OpsResponse } from '$lib/api/types';
import { server } from '../../api/__tests__/server';
import {
	applyDelta,
	getStagedOps,
	resetModelStore,
	setModelApiConfig
} from '../../state/model.svelte';
import { resetCheckout, setCheckoutApiConfig, setProjectInfo } from '../../state/checkout.svelte';
import { answerConfirm, getPendingConfirm, resetConfirm } from '../../state/confirm.svelte';
import { handleFeedEvent, resetRealtime } from '../../state/realtime.svelte';
import { clearSelection, getSelection, select } from '../../state/selection.svelte';
import Inspector from '../Inspector.svelte';

const BASE = 'http://api.test/api/v1';

beforeAll(() => {
	server.listen({ onUnhandledRequest: 'error' });
	setModelApiConfig({ baseUrl: BASE });
	setCheckoutApiConfig({ baseUrl: BASE });
});
afterEach(() => {
	server.resetHandlers();
	clearSelection();
	vi.restoreAllMocks();
});
afterAll(() => {
	setModelApiConfig(undefined);
	setCheckoutApiConfig(undefined);
	server.close();
});
beforeEach(() => {
	resetConfirm();
	resetModelStore();
	resetCheckout();
	resetRealtime();
	clearSelection();
	setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
	server.use(
		// The Inspector's relationships panel reads through the component's own
		// (origin-less) client config, so match any origin.
		http.get(`*/model/elements/:id/relationships`, () => HttpResponse.json({ items: [], total: 0 }))
	);
});

function el(id: string, props: Record<string, unknown> = {}, rev = 0): Element {
	return { id, type_name: 'Block', properties: props, rev };
}

function delta(partial: Partial<OpsResponse>): OpsResponse {
	return {
		model_rev: partial.model_rev ?? 1,
		id_map: {},
		changed_elements: [],
		changed_relationships: [],
		deleted_element_ids: [],
		deleted_relationship_ids: [],
		issues_removed_owner_ids: [],
		issues_added: [],
		issue_counts: {},
		...partial
	};
}

const settle = () => new Promise((r) => setTimeout(r, 10));

function deleteButton(): HTMLButtonElement {
	const node = document.body.querySelector('[data-testid="delete-element"]');
	if (node === null) throw new Error('delete-element not rendered');
	return node as HTMLButtonElement;
}

function renderSelected(id: string) {
	select({ kind: 'element', id });
	const component = mount(Inspector, { target: document.body });
	flushSync();
	return component;
}

it('confirms, takes a DELETE lease, then stages delete_element and deselects', async () => {
	const lockBodies: unknown[] = [];
	server.use(
		http.post(`${BASE}/locks`, async ({ request }) => {
			lockBodies.push(await request.json());
			return HttpResponse.json({
				token: 'tok1',
				leases: [
					{
						resource_id: 'e1',
						mode: 'exclusive',
						holder: 'default-user',
						token: 'tok1',
						intent: 'delete',
						expires_at: 0
					}
				]
			});
		})
	);
	applyDelta(delta({ changed_elements: [el('e1')] }));

	const c = renderSelected('e1');
	try {
		deleteButton().click();
		flushSync();

		// Nothing happens until the user answers: no lease request, no staged op.
		expect(getPendingConfirm()?.title).toBe('Delete element');
		expect(lockBodies).toHaveLength(0);
		expect(getStagedOps()).toHaveLength(0);

		answerConfirm(true);
		await settle();
		flushSync();

		// The lease is taken with DELETE intent (which conflicts with ANY peer
		// lease server-side) BEFORE the op is staged.
		expect(lockBodies).toEqual([
			{ targets: [{ resource_id: 'e1', mode: 'exclusive' }], intent: 'delete', steal: false }
		]);
		expect(getStagedOps()).toEqual([{ kind: 'delete_element', id: 'e1' }]);
		expect(getSelection()).toBeNull();
	} finally {
		unmount(c);
	}
});

it('stages nothing and keeps the selection when the confirmation is declined', async () => {
	let acquires = 0;
	server.use(
		http.post(`${BASE}/locks`, () => {
			acquires += 1;
			return HttpResponse.json({ token: 'tok1', leases: [] });
		})
	);
	applyDelta(delta({ changed_elements: [el('e1')] }));

	const c = renderSelected('e1');
	try {
		deleteButton().click();
		flushSync();
		answerConfirm(false);
		await settle();
		flushSync();

		expect(acquires).toBe(0);
		expect(getStagedOps()).toHaveLength(0);
		expect(getSelection()).toEqual({ kind: 'element', id: 'e1' });
	} finally {
		unmount(c);
	}
});

it('disables Delete for viewers', () => {
	setProjectInfo({ role: 'viewer', lockTtlSeconds: 300 });
	applyDelta(delta({ changed_elements: [el('e1')] }));

	const c = renderSelected('e1');
	try {
		expect(deleteButton().disabled).toBe(true);
		expect(deleteButton().title).toBe('You have view-only access');
	} finally {
		unmount(c);
	}
});

it('disables Delete while a peer holds the element lock', () => {
	applyDelta(delta({ changed_elements: [el('e1')] }));
	handleFeedEvent({
		type: 'lock',
		action: 'acquired',
		leases: [{ resource_id: 'e1', mode: 'exclusive', holder_id: 'bob' }]
	});

	const c = renderSelected('e1');
	try {
		expect(deleteButton().disabled).toBe(true);
		expect(deleteButton().title).toBe('Locked by another user');
	} finally {
		unmount(c);
	}
});

it('offers no Delete on a relationship selection (the list owns Disconnect)', () => {
	applyDelta(
		delta({
			changed_elements: [el('e1'), el('e2')],
			changed_relationships: [
				{ id: 'r1', type_name: 'Feeds', source_id: 'e1', target_id: 'e2', properties: {}, rev: 1 }
			]
		})
	);
	select({ kind: 'relationship', id: 'r1' });
	const c = mount(Inspector, { target: document.body });
	try {
		flushSync();
		expect(document.body.querySelector('[data-testid="delete-element"]')).toBeNull();
	} finally {
		unmount(c);
	}
});
