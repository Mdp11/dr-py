import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ReplicaFallbackNotice from '../ReplicaFallbackNotice.svelte';

vi.mock('$lib/state', async (orig) => {
	const actual = await orig<typeof import('$lib/state')>();
	return {
		...actual,
		dismissReplicaNotice: vi.fn()
	};
});

import { dismissReplicaNotice } from '$lib/state';

let mounted: ReturnType<typeof mount> | null = null;

afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = null;
	document.body.innerHTML = '';
	vi.clearAllMocks();
});

describe('ReplicaFallbackNotice', () => {
	it('renders the notice, its role, and the fallback copy verbatim', () => {
		mounted = mount(ReplicaFallbackNotice, { target: document.body });
		flushSync();

		const el = document.querySelector('[data-testid="replica-notice"]');
		expect(el).not.toBeNull();
		expect(el?.getAttribute('role')).toBe('alert');
		expect(el?.textContent?.replace(/\s+/g, ' ').trim()).toContain(
			'The in-browser engine could not start — this tab reads from the server instead. Reload the page to try again.'
		);
	});

	it('Dismiss calls dismissReplicaNotice', () => {
		mounted = mount(ReplicaFallbackNotice, { target: document.body });
		flushSync();

		const button = document.querySelector<HTMLButtonElement>('button');
		expect(button?.textContent?.trim()).toBe('Dismiss');
		button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		flushSync();

		expect(dismissReplicaNotice).toHaveBeenCalledOnce();
	});
});
