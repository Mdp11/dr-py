import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import * as viewsApi from '$lib/api/views';
import {
	clearViewState,
	getAddViewOpen,
	getDeleteViewOpen,
	loadViews,
	openAddView,
	openDeleteView,
	setProjectInfo
} from '$lib/state';
import { resetCheckout } from '$lib/state/checkout.svelte';
import { setActiveViewId } from '$lib/state/active-view.svelte';
import ViewMenu from '../ViewMenu.svelte';

let host: HTMLElement;
let app: ReturnType<typeof mount> | null = null;

beforeEach(async () => {
	resetCheckout();
	clearViewState();
	vi.spyOn(viewsApi, 'listViews').mockResolvedValue([
		{ id: 'v1', name: 'Alpha', view_rev: 0 },
		{ id: 'v2', name: 'Zeta', view_rev: 0 }
	]);
	await loadViews();
	host = document.createElement('div');
	document.body.appendChild(host);
});

afterEach(() => {
	if (app) unmount(app);
	app = null;
	host.remove();
	clearViewState();
	vi.restoreAllMocks();
});

function openMenu(role: 'editor' | 'viewer') {
	setProjectInfo({ role, lockTtlSeconds: 300 });
	app = mount(ViewMenu, { target: host });
	flushSync();
	host.querySelector<HTMLButtonElement>('[data-testid="view-menu-trigger"]')!.click();
	flushSync();
}

function items(): string[] {
	return [...document.body.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')].map(
		(n) => n.textContent?.trim() ?? ''
	);
}

describe('ViewMenu', () => {
	it('lists the views with the active one checked, plus Add/Delete for an editor', () => {
		setActiveViewId('v2');
		openMenu('editor');
		expect(items()).toEqual(['Alpha', 'Zeta', 'Add view…', 'Delete view…']);
		const checked = [...document.body.querySelectorAll('[role="menuitemradio"]')].filter(
			(n) => n.getAttribute('aria-checked') === 'true'
		);
		expect(checked.map((n) => n.textContent?.trim())).toEqual(['Zeta']);
	});

	it('hides Add/Delete from a viewer', () => {
		openMenu('viewer');
		expect(items()).toEqual(['Alpha', 'Zeta']);
	});

	it('shows "No views" when the project has none', async () => {
		vi.spyOn(viewsApi, 'listViews').mockResolvedValue([]);
		await loadViews();
		openMenu('editor');
		expect(items()).toEqual(['No views', 'Add view…', 'Delete view…']);
	});

	it('picking a view selects it', async () => {
		setActiveViewId('v1');
		vi.spyOn(viewsApi, 'getView').mockResolvedValue({
			view: { name: 'Zeta', folders: [], artifacts: [] },
			warnings: [],
			view_rev: 0
		});
		openMenu('editor');
		const zeta = [...document.body.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
			(n) => n.textContent?.trim() === 'Zeta'
		)!;
		zeta.click();
		flushSync();
		await new Promise((r) => setTimeout(r, 0));
		expect(viewsApi.getView).toHaveBeenCalledWith('v2');
	});

	it('mounting clears dialog flags latched while no dialog was mounted', () => {
		openAddView();
		openDeleteView();
		setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
		app = mount(ViewMenu, { target: host });
		flushSync();
		expect(getAddViewOpen()).toBe(false);
		expect(getDeleteViewOpen()).toBe(false);
	});

	it('unmounting closes an open dialog', () => {
		setProjectInfo({ role: 'editor', lockTtlSeconds: 300 });
		app = mount(ViewMenu, { target: host });
		flushSync();
		openAddView();
		flushSync();
		expect(getAddViewOpen()).toBe(true);
		unmount(app);
		app = null;
		expect(getAddViewOpen()).toBe(false);
	});
});
