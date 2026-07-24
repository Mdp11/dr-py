import { flushSync, mount, unmount } from 'svelte';
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import { server } from '../../api/__tests__/server';
import { resetModelStore, seedElements, setModelApiConfig } from '../../state/model.svelte';
import { resetInspectionHistory } from '../../state/inspection-history.svelte';
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
	vi.useRealTimers();
});
afterAll(() => {
	setModelApiConfig(undefined);
	server.close();
});
beforeEach(() => {
	resetModelStore();
	resetInspectionHistory();
	clearSelection();
	server.use(
		http.get(`*/model/elements/:id/relationships`, () => HttpResponse.json({ items: [], total: 0 }))
	);
	seedElements([
		{ id: 'e1', type_name: 'Pump', properties: { name: 'P-101' }, rev: 1 },
		{ id: 'e2', type_name: 'Tank', properties: { name: 'T-200' }, rev: 1 }
	]);
});

function backButton(): HTMLButtonElement {
	return document.querySelector('[data-testid="inspector-history-back"]') as HTMLButtonElement;
}
function forwardButton(): HTMLButtonElement {
	return document.querySelector('[data-testid="inspector-history-forward"]') as HTMLButtonElement;
}

const settle = () => new Promise((r) => setTimeout(r, 30));

it('arrows render in every state and disable without history', () => {
	const component = mount(Inspector, { target: document.body });
	try {
		flushSync();
		// no selection at all — the cluster still renders
		expect(backButton()).not.toBeNull();
		expect(backButton().disabled).toBe(true);
		expect(forwardButton().disabled).toBe(true);
	} finally {
		unmount(component);
	}
});

it('click-Back returns to the previous element and enables Forward', () => {
	select({ kind: 'element', id: 'e1' });
	select({ kind: 'element', id: 'e2' });
	const component = mount(Inspector, { target: document.body });
	try {
		flushSync();
		expect(backButton().disabled).toBe(false);
		expect(forwardButton().disabled).toBe(true);
		backButton().click();
		flushSync();
		expect(getSelection()).toEqual({ kind: 'element', id: 'e1' });
		// A plain click must NOT also pop the history menu: bits-ui's own
		// open-on-click/pointerdown toggles are overridden after the {...props}
		// spread, so only the longpress action can open it.
		expect(document.querySelector('[data-slot="dropdown-menu-content"]')).toBeNull();
		expect(forwardButton().disabled).toBe(false);
		forwardButton().click();
		flushSync();
		expect(getSelection()).toEqual({ kind: 'element', id: 'e2' });
	} finally {
		unmount(component);
	}
});

it('long-press Back opens a dropdown with Name + Stereotype + id; picking jumps', () => {
	vi.useFakeTimers();
	select({ kind: 'element', id: 'e1' });
	select({ kind: 'element', id: 'e2' });
	const component = mount(Inspector, { target: document.body });
	try {
		flushSync();
		backButton().dispatchEvent(
			new PointerEvent('pointerdown', { button: 0, clientX: 5, clientY: 5, bubbles: true })
		);
		vi.advanceTimersByTime(600);
		flushSync();
		const entry = document.querySelector('[data-testid="inspector-history-entry-0"]');
		expect(entry).not.toBeNull();
		expect(entry?.textContent).toContain('P-101');
		expect(entry?.textContent).toContain('Pump');
		expect(entry?.textContent).toContain('e1');
		(entry as HTMLElement).click();
		flushSync();
		expect(getSelection()).toEqual({ kind: 'element', id: 'e1' });
	} finally {
		unmount(component);
		vi.useRealTimers();
	}
});

it('right-click (contextmenu) also opens the dropdown', () => {
	select({ kind: 'element', id: 'e1' });
	select({ kind: 'element', id: 'e2' });
	const component = mount(Inspector, { target: document.body });
	try {
		flushSync();
		backButton().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		flushSync();
		const entry = document.querySelector('[data-testid="inspector-history-entry-0"]');
		expect(entry).not.toBeNull();
		expect(document.querySelector('[data-slot="dropdown-menu-content"]')).not.toBeNull();
	} finally {
		unmount(component);
	}
});

it('an entry whose element is unknown falls back to its bare id', () => {
	// e3 is never seeded into getTreeElements(), so resolveRows() finds no
	// cached element for it and the name falls through to the entry's bare id
	// (no fetch is involved: the Inspector only ever fetches the *currently
	// selected* element, e2, via ensureElement).
	select({ kind: 'element', id: 'e3' });
	select({ kind: 'element', id: 'e2' });
	const component = mount(Inspector, { target: document.body });
	try {
		flushSync();
		backButton().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
		flushSync();
		const entry = document.querySelector('[data-testid="inspector-history-entry-0"]');
		expect(entry).not.toBeNull();
		// Target the name span specifically (not the whole item, which always
		// also renders row.id in its own mono span) so a regression that made
		// the fallback resolve to '' rather than the bare id would be caught.
		// A testid, not the Tailwind classes, so a layout tweak can't break this.
		const nameSpan = entry?.querySelector('[data-testid="inspector-history-entry-name"]');
		expect(nameSpan?.textContent).toBe('e3');
	} finally {
		unmount(component);
	}
});

it('back-navigating to a deleted element lands on "Selection not found" (deleted elements stay navigable)', async () => {
	// Design decision under test: the visit stack never prunes deleted ids, so
	// Back can land on one — the Inspector's existing not-found state is the
	// mechanism, driven by ensureElement's 404 marking `_missingElementIds`.
	server.use(
		http.get(`*/model/elements/:id`, () => HttpResponse.json({ detail: 'nope' }, { status: 404 }))
	);
	select({ kind: 'element', id: 'ghost' }); // never seeded; the server 404s it
	select({ kind: 'element', id: 'e2' }); // seeded — no fetch needed, entity renders
	const component = mount(Inspector, { target: document.body });
	try {
		flushSync();
		expect(document.body.textContent).toContain('Properties');
		backButton().click();
		flushSync();
		expect(getSelection()).toEqual({ kind: 'element', id: 'ghost' });
		await settle();
		flushSync();
		expect(document.body.textContent).toContain('Selection not found');
	} finally {
		unmount(component);
	}
});
