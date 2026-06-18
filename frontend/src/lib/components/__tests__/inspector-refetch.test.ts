import { flushSync, mount, unmount } from 'svelte';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import type { Element, OpsResponse } from '$lib/api/types';
import { server } from '../../api/__tests__/server';
import { applyDelta, emit, resetModelStore, setModelApiConfig } from '../../state/model.svelte';
import { clearSelection, select } from '../../state/selection.svelte';
import Inspector from '../Inspector.svelte';

const BASE = 'http://api.test/api/v1';

beforeAll(() => {
	server.listen({ onUnhandledRequest: 'error' });
	setModelApiConfig({ baseUrl: BASE });
});
afterEach(() => {
	vi.useRealTimers();
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

// Let any synchronously-dispatched fetch reach the MSW handler.
const settle = () => new Promise((r) => setTimeout(r, 10));

it('does not refetch the selected element relationships on every property keystroke', async () => {
	let relFetches = 0;
	server.use(
		// component-issued reads don't thread the test ClientConfig, so they hit
		// the default origin rather than BASE — match any origin with `*`.
		http.get(`*/model/elements/:id/relationships`, () => {
			relFetches += 1;
			return HttpResponse.json({ items: [], total: 0 });
		})
	);

	// a selected, cached element (the inspector renders its property form +
	// relationships panel against this)
	applyDelta(delta({ model_rev: 1, changed_elements: [el('e1', { description: '' }, 1)] }));
	select({ kind: 'element', id: 'e1' });

	const component = mount(Inspector, { target: document.body });
	try {
		flushSync();
		await vi.waitFor(() => expect(relFetches).toBe(1)); // mount fetch only

		// type a letter into the description: an optimistic update_element op.
		// This replaces e1's cached object (new identity) — the regression is
		// that this churn made the relationships fetch effect re-run. Spec B
		// stages the edit locally; there is no flush ack.
		emit({ kind: 'update_element', id: 'e1', properties_patch: { description: 'a' } });
		flushSync();
		await settle();

		expect(relFetches).toBe(1); // still ONE — no per-keystroke refetch
	} finally {
		unmount(component);
	}
});
