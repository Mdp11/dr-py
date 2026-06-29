import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { http, HttpResponse } from 'msw';
import { server } from '../../api/__tests__/server';
import Page from '../../../routes/projects/+page.svelte';

const goto = vi.fn();
vi.mock('$app/navigation', () => ({ goto: (...a: unknown[]) => goto(...a) }));

// Mutable flag so individual tests can flip admin on/off without re-mocking.
let adminFlag = false;
vi.mock('$lib/state', async (orig) => ({ ...(await orig()), isAdmin: () => adminFlag }));

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
beforeEach(() => {
	adminFlag = false;
});
afterEach(() => {
	server.resetHandlers();
	document.body.innerHTML = '';
	vi.clearAllMocks();
});
afterAll(() => server.close());

function seed() {
	server.use(
		http.get('/api/v1/projects', () =>
			HttpResponse.json([
				{ id: 'p1', name: 'Alpha', role: 'owner' },
				{ id: 'p2', name: 'Beta', role: 'viewer' }
			])
		)
	);
}

async function settle() {
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

describe('projects page', () => {
	it('lists projects and opens one on click', async () => {
		seed();
		const c = mount(Page, { target: document.body });
		await settle();
		expect(document.body.textContent).toContain('Alpha');
		expect(document.body.textContent).toContain('Beta');
		const alpha = [...document.querySelectorAll('button,a')].find((el) =>
			el.textContent?.includes('Alpha')
		) as HTMLElement;
		alpha.click();
		expect(goto).toHaveBeenCalledWith('/p/p1');
		unmount(c);
	});

	it('filters by the search box', async () => {
		seed();
		const c = mount(Page, { target: document.body });
		await settle();
		const search = document.querySelector('input[type="search"]') as HTMLInputElement;
		search.value = 'bet';
		search.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		expect(document.body.textContent).toContain('Beta');
		expect(document.body.textContent).not.toContain('Alpha');
		unmount(c);
	});

	describe('loading / error states', () => {
		it('shows loading indicator before fetch resolves', () => {
			// Never resolve so we can inspect the loading state synchronously.
			server.use(http.get('/api/v1/projects', () => new Promise(() => {})));
			const c = mount(Page, { target: document.body });
			flushSync();
			expect(document.body.textContent).toContain('Loading');
			unmount(c);
		});

		it('shows error message when fetch fails', async () => {
			server.use(http.get('/api/v1/projects', () => HttpResponse.error()));
			const c = mount(Page, { target: document.body });
			await settle();
			expect(document.body.textContent).toContain('Failed to load projects.');
			// Retry button should be present.
			const retry = [...document.querySelectorAll('button')].find((el) =>
				el.textContent?.toLowerCase().includes('retry')
			);
			expect(retry).toBeTruthy();
			unmount(c);
		});
	});

	describe('admin visibility', () => {
		it('hides "New project" button when user is not admin', async () => {
			adminFlag = false;
			seed();
			const c = mount(Page, { target: document.body });
			await settle();
			const btn = [...document.querySelectorAll('button')].find((el) =>
				el.textContent?.toLowerCase().includes('new project')
			);
			expect(btn).toBeUndefined();
			unmount(c);
		});

		it('shows "New project" button when user is admin', async () => {
			adminFlag = true;
			seed();
			const c = mount(Page, { target: document.body });
			await settle();
			const btn = [...document.querySelectorAll('button')].find((el) =>
				el.textContent?.toLowerCase().includes('new project')
			);
			expect(btn).toBeTruthy();
			unmount(c);
		});
	});
});
