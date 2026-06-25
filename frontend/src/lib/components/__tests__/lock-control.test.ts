import { flushSync, mount, unmount } from 'svelte';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import type { Element, OpsResponse } from '$lib/api/types';
import { server } from '../../api/__tests__/server';
import { applyDelta, emit, getStagedOpsFor, resetModelStore } from '../../state/model.svelte';
import {
	_recordLeases,
	isCheckedOutByMe,
	resetCheckout,
	setCheckoutApiConfig,
	setProjectInfo
} from '../../state/checkout.svelte';
import { handleFeedEvent, resetRealtime } from '../../state/realtime.svelte';
import LockControl from '../Inspector/LockControl.svelte';

const BASE = 'http://api.test/api/v1';

beforeAll(() => {
	server.listen({ onUnhandledRequest: 'error' });
	setCheckoutApiConfig({ baseUrl: BASE });
});
afterEach(() => {
	server.resetHandlers();
	vi.restoreAllMocks();
});
afterAll(() => {
	setCheckoutApiConfig(undefined);
	server.close();
});
beforeEach(() => {
	resetModelStore();
	resetCheckout();
	resetRealtime();
	setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
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

function lease(resourceId: string, holder: string, token = 'tok1') {
	return {
		resource_id: resourceId,
		mode: 'exclusive',
		holder,
		token,
		intent: 'edit',
		expires_at: 0
	};
}

const settle = () => new Promise((r) => setTimeout(r, 10));

function render(elementId: string) {
	const component = mount(LockControl, { target: document.body, props: { elementId } });
	flushSync();
	return component;
}

function control(): HTMLElement {
	const node = document.body.querySelector('[data-testid="lock-control"]');
	if (node === null) throw new Error('lock-control not rendered');
	return node as HTMLElement;
}

it('shows "Lock" when nobody holds the element and acquires the lock on click', async () => {
	let acquired = 0;
	server.use(
		http.post(`${BASE}/locks`, async () => {
			acquired += 1;
			return HttpResponse.json({ token: 'tok1', leases: [lease('e1', 'default-user')] });
		})
	);
	applyDelta(delta({ changed_elements: [el('e1')] }));

	const c = render('e1');
	try {
		expect(control().textContent?.trim()).toBe('Lock');

		control().click();
		await settle();
		flushSync();

		expect(acquired).toBe(1);
		expect(isCheckedOutByMe('e1')).toBe(true);
		expect(control().textContent?.trim()).toBe('Unlock');
	} finally {
		unmount(c);
	}
});

it('disables "Lock" for viewers', () => {
	setProjectInfo({ role: 'viewer', lockTtlSeconds: 300 });
	applyDelta(delta({ changed_elements: [el('e1')] }));

	const c = render('e1');
	try {
		const btn = control() as HTMLButtonElement;
		expect(btn.textContent?.trim()).toBe('Lock');
		expect(btn.disabled).toBe(true);
	} finally {
		unmount(c);
	}
});

it('shows a disabled "Locked by <peer>" badge when a peer holds it', () => {
	applyDelta(delta({ changed_elements: [el('e1')] }));
	handleFeedEvent({
		type: 'lock',
		action: 'acquired',
		leases: [{ resource_id: 'e1', mode: 'exclusive', holder_id: 'bob' }]
	});

	const c = render('e1');
	try {
		const node = control();
		expect(node.tagName).toBe('SPAN');
		expect(node.textContent).toContain('bob');
	} finally {
		unmount(c);
	}
});

it('unlocks without confirmation when the element has no staged changes', async () => {
	let released = 0;
	server.use(
		http.post(`${BASE}/locks/release`, async () => {
			released += 1;
			return HttpResponse.json({ released: 1 });
		})
	);
	const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
	applyDelta(delta({ changed_elements: [el('e1')] }));
	_recordLeases([lease('e1', 'default-user')]);

	const c = render('e1');
	try {
		expect(control().textContent?.trim()).toBe('Unlock');

		control().click();
		await settle();
		flushSync();

		expect(confirmSpy).not.toHaveBeenCalled();
		expect(released).toBe(1);
		expect(isCheckedOutByMe('e1')).toBe(false);
		expect(control().textContent?.trim()).toBe('Lock');
	} finally {
		unmount(c);
	}
});

it('confirms before discarding staged changes on unlock; keeps the lock when declined', async () => {
	let released = 0;
	server.use(
		http.post(`${BASE}/locks/release`, async () => {
			released += 1;
			return HttpResponse.json({ released: 1 });
		})
	);
	const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
	applyDelta(delta({ changed_elements: [el('e1', { name: '' })] }));
	_recordLeases([lease('e1', 'default-user')]);
	emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'edited' } });
	flushSync();
	expect(getStagedOpsFor('e1').length).toBe(1);

	const c = render('e1');
	try {
		control().click();
		await settle();
		flushSync();

		// declined: warning shown, nothing released, edit + lock retained
		expect(confirmSpy).toHaveBeenCalledOnce();
		expect(released).toBe(0);
		expect(isCheckedOutByMe('e1')).toBe(true);
		expect(getStagedOpsFor('e1').length).toBe(1);

		// accept this time: edit discarded and lock released
		confirmSpy.mockReturnValue(true);
		control().click();
		await settle();
		flushSync();

		expect(released).toBe(1);
		expect(isCheckedOutByMe('e1')).toBe(false);
		expect(getStagedOpsFor('e1').length).toBe(0);
	} finally {
		unmount(c);
	}
});
