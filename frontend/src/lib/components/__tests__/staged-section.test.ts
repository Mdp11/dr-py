import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { server } from '$lib/api/__tests__/server';
import {
	clearSelection,
	emit,
	ensureElement,
	getCachedElements,
	getSelection,
	getStagedDepth,
	resetModelStore,
	seedElements,
	stagedSettled
} from '$lib/state';
import { createTempId } from '$lib/state/ops';
import { engineStore, type EngineStore } from '../../state/__tests__/support/engine-store';
import StagedSection from '../Sidebar/StagedSection.svelte';

// `discardElementCascade` is wrapped so a per-row revert can be asserted to
// call it, without breaking the real behavior it forwards to (both the
// legacy tests below and the engine ones over `engineStore()` exercise the
// real revert).
vi.mock('$lib/state', async (orig) => {
	const actual = await orig<typeof import('$lib/state')>();
	return { ...actual, discardElementCascade: vi.fn(actual.discardElementCascade) };
});

import { discardElementCascade } from '$lib/state';

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

function mountSection(): void {
	app = mount(StagedSection, { target: host });
	flushSync();
}

beforeEach(() => {
	resetModelStore();
	clearSelection();
	localStorage.clear();
	vi.mocked(discardElementCascade).mockClear();
	host = document.createElement('div');
	document.body.appendChild(host);
});

afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
});

describe('StagedSection', () => {
	it('renders nothing when no ops are staged', () => {
		mountSection();
		expect(host.querySelector('[data-testid="staged-section"]')).toBeNull();
	});

	it('lists staged elements with status badges and a count', () => {
		seedElements([
			{ id: 'e1', type_name: 'Device', properties: { name: 'Edited one' }, rev: 1 },
			{ id: 'e2', type_name: 'Device', properties: { name: 'Doomed' }, rev: 1 }
		]);
		const tmp = createTempId();
		emit({
			kind: 'create_element',
			temp_id: tmp,
			type_name: 'Device',
			properties: { name: 'Fresh' }
		});
		emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'Edited two' } });
		emit({ kind: 'delete_element', id: 'e2' });
		mountSection();
		expect(host.textContent).toContain('Staged elements');
		expect(host.textContent).toContain('3');
		expect(host.querySelector(`[data-staged-id="${tmp}"]`)?.getAttribute('data-status')).toBe(
			'new'
		);
		expect(host.querySelector('[data-staged-id="e1"]')?.getAttribute('data-status')).toBe(
			'modified'
		);
		expect(host.querySelector('[data-staged-id="e2"]')?.getAttribute('data-status')).toBe(
			'deleted'
		);
		expect(host.textContent).toContain('Fresh');
		expect(host.textContent).toContain('Edited two');
		expect(host.textContent).toContain('Doomed'); // name from journal pre-state
	});

	it('clicking a row selects the element; deleted rows have no select button', () => {
		seedElements([{ id: 'e2', type_name: 'Device', properties: { name: 'Doomed' }, rev: 1 }]);
		const tmp = createTempId();
		emit({
			kind: 'create_element',
			temp_id: tmp,
			type_name: 'Device',
			properties: { name: 'Fresh' }
		});
		emit({ kind: 'delete_element', id: 'e2' });
		mountSection();
		const newRow = host.querySelector(`[data-staged-id="${tmp}"]`)!;
		(newRow.querySelector('button.staged-select') as HTMLButtonElement).click();
		flushSync();
		expect(getSelection()).toEqual({ kind: 'element', id: tmp });
		const deletedRow = host.querySelector('[data-staged-id="e2"]')!;
		expect(deletedRow.querySelector('button.staged-select')).toBeNull();
	});

	it('revert un-creates a new element, clears its selection, and hides the empty section', () => {
		const tmp = createTempId();
		emit({
			kind: 'create_element',
			temp_id: tmp,
			type_name: 'Device',
			properties: { name: 'Fresh' }
		});
		mountSection();
		(
			host.querySelector(`[data-staged-id="${tmp}"] button.staged-select`) as HTMLButtonElement
		).click();
		flushSync();
		(host.querySelector('[data-testid="staged-revert"]') as HTMLButtonElement).click();
		flushSync();
		expect(getStagedDepth()).toBe(0);
		expect(getCachedElements().has(tmp)).toBe(false);
		expect(getSelection()).toBeNull();
		expect(host.querySelector('[data-testid="staged-section"]')).toBeNull();
	});

	it('revert on a modified element keeps the selection', () => {
		seedElements([{ id: 'e1', type_name: 'Device', properties: { name: 'a' }, rev: 1 }]);
		emit({ kind: 'update_element', id: 'e1', properties_patch: { name: 'b' } });
		mountSection();
		(host.querySelector('[data-staged-id="e1"] button.staged-select') as HTMLButtonElement).click();
		flushSync();
		(host.querySelector('[data-testid="staged-revert"]') as HTMLButtonElement).click();
		flushSync();
		expect(getCachedElements().get('e1')?.properties.name).toBe('a');
		expect(getSelection()).toEqual({ kind: 'element', id: 'e1' });
	});

	it('virtualizes: mounts a window of rows while the header counts them all', () => {
		// A snippet batch can stage thousands of ops; the scroller shows ~8 rows.
		// In this detached host clientHeight is 0, so the window degrades to the
		// overscan band — rows still render, just not all of them.
		const ids = Array.from({ length: 40 }, () => createTempId());
		for (const [i, id] of ids.entries()) {
			emit({
				kind: 'create_element',
				temp_id: id,
				type_name: 'Device',
				properties: { name: `el-${String(i).padStart(2, '0')}` }
			});
		}
		mountSection();
		expect(host.textContent).toContain('40');
		const mounted = host.querySelectorAll('[data-staged-id]');
		expect(mounted.length).toBeGreaterThan(0);
		expect(mounted.length).toBeLessThan(ids.length);
		// the bottom spacer stands in for the unmounted rows, so the scrollbar
		// still reflects the full list
		const spacers = host.querySelectorAll('li[aria-hidden="true"]');
		expect(spacers.length).toBe(2);
		expect(spacers[1].getAttribute('style')).not.toBe('height: 0px');
	});

	it('marks the selected row with aria-current', () => {
		const tmp = createTempId();
		emit({
			kind: 'create_element',
			temp_id: tmp,
			type_name: 'Device',
			properties: { name: 'Fresh' }
		});
		mountSection();
		const btn = host.querySelector(
			`[data-staged-id="${tmp}"] button.staged-select`
		) as HTMLButtonElement;
		expect(btn.getAttribute('aria-current')).toBeNull();
		btn.click();
		flushSync();
		expect(
			host
				.querySelector(`[data-staged-id="${tmp}"] button.staged-select`)
				?.getAttribute('aria-current')
		).toBe('true');
	});

	it('header toggle collapses the row list', () => {
		const tmp = createTempId();
		emit({
			kind: 'create_element',
			temp_id: tmp,
			type_name: 'Device',
			properties: { name: 'Fresh' }
		});
		mountSection();
		expect(host.querySelector(`[data-staged-id="${tmp}"]`)).not.toBeNull();
		(host.querySelector('[data-testid="staged-header"]') as HTMLButtonElement).click();
		flushSync();
		expect(host.querySelector(`[data-staged-id="${tmp}"]`)).toBeNull();
		expect(localStorage.getItem('ui.stagedSectionCollapsed')).toBe('true');
	});
});

// Proves the section needs no change for engine staging: `deriveStagedElementRows`
// is fed by `getStagedDiff()`, which the facade already answers from the
// engine's own diff in engine mode (D3, D14).
describe('StagedSection over the engine', () => {
	let store: EngineStore | null = null;

	beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
	afterAll(() => server.close());

	afterEach(() => {
		store?.dispose();
		store = null;
	});

	it('rows are new, modified and deleted, fed by the engine diff; revert calls discardElementCascade', async () => {
		const s = (store = await engineStore());
		// e_000002 must be cached for the update op to write its patched name
		// into the cache the "modified" row reads; the "deleted" row reads its
		// name from the diff's `before` alone, so e_000008 needs no priming.
		// e_000008 (a Team, no containment children of its own — unlike an
		// Organization, whose delete_element cascades through `Owns` and would
		// add a deleted row per owned Team) keeps this a clean 3-row case.
		await ensureElement('e_000002');

		emit({
			kind: 'create_element',
			temp_id: 'tmp_x',
			type_name: 'Organization',
			properties: { name: 'Fresh' }
		});
		emit({ kind: 'update_element', id: 'e_000002', properties_patch: { name: 'Quartz' } });
		emit({ kind: 'delete_element', id: 'e_000008' });
		await s.sync.settled();
		await stagedSettled();

		mountSection();

		expect(host.textContent).toContain('Staged elements');
		// The header's own count span, not `host.textContent` at large — which
		// would also be satisfied by "e_000008" or "Team-003" below, trivially
		// passing even if the count itself were wrong.
		expect(
			host.querySelector('[data-testid="staged-header"] span.font-mono')?.textContent?.trim()
		).toBe('3');
		expect(host.querySelector('[data-staged-id="tmp_x"]')?.getAttribute('data-status')).toBe('new');
		expect(host.querySelector('[data-staged-id="e_000002"]')?.getAttribute('data-status')).toBe(
			'modified'
		);
		expect(host.querySelector('[data-staged-id="e_000008"]')?.getAttribute('data-status')).toBe(
			'deleted'
		);
		expect(host.textContent).toContain('Fresh');
		expect(host.textContent).toContain('Quartz');
		// The deleted row's name comes from the diff's committed `before`
		// snapshot, not the (now-empty) cache.
		expect(host.textContent).toContain('Team-003');

		const revertBtn = host.querySelector(
			'[data-staged-id="tmp_x"] [data-testid="staged-revert"]'
		) as HTMLButtonElement;
		revertBtn.click();
		flushSync();

		expect(discardElementCascade).toHaveBeenCalledWith('tmp_x');
		await vi.mocked(discardElementCascade).mock.results[0]!.value;
	});
});
