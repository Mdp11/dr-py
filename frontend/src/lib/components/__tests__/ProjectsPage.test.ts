import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import { http, HttpResponse } from 'msw';
import { server } from '../../api/__tests__/server';
import Page from '../../../routes/projects/+page.svelte';

const goto = vi.fn();
vi.mock('$app/navigation', () => ({ goto: (...a: unknown[]) => goto(...a) }));
vi.mock('$lib/state', async (orig) => ({ ...(await orig()), isAdmin: () => false }));

beforeAll(() => server.listen({ onUnhandledRequest: 'bypass' }));
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

describe('projects page', () => {
	it('lists projects and opens one on click', async () => {
		seed();
		const c = mount(Page, { target: document.body });
		// allow the onMount fetch microtasks to settle
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
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
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
		const search = document.querySelector('input[type="search"]') as HTMLInputElement;
		search.value = 'bet';
		search.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		expect(document.body.textContent).toContain('Beta');
		expect(document.body.textContent).not.toContain('Alpha');
		unmount(c);
	});
});
