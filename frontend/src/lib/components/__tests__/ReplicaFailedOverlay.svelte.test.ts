import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import ReplicaFailedOverlay from '../ReplicaFailedOverlay.svelte';

// `isReplicaRetrying` is backed by real `$state` here, not a bare `vi.fn()`
// return value: the focus-follows-retry test needs the component's own
// `$derived` to react to a LATER change, which a plain mocked function
// (no tracked read) would never trigger. `__setRetrying` is this mock's own
// escape hatch, not part of the real `$lib/state` module.
vi.mock('$lib/state', async (orig) => {
	const actual = await orig<typeof import('$lib/state')>();
	const box = $state<{ retrying: boolean; reason: string | null }>({
		retrying: false,
		reason: null
	});
	return {
		...actual,
		isReplicaRetrying: () => box.retrying,
		getReplicaBlockReason: () => box.reason,
		retryReplica: vi.fn(),
		__setRetrying: (value: boolean) => {
			box.retrying = value;
		},
		__setReason: (value: string | null) => {
			box.reason = value;
		}
	};
});

import { retryReplica } from '$lib/state';
import * as state from '$lib/state';

// The mock above adds this export; it does not exist on the real module, so
// it is reached through a cast rather than a named import `tsc` would refuse.
const setRetrying = (value: boolean): void =>
	(state as unknown as { __setRetrying(value: boolean): void }).__setRetrying(value);

const setReason = (value: string | null): void =>
	(state as unknown as { __setReason(value: string | null): void }).__setReason(value);

let mounted: ReturnType<typeof mount> | null = null;

beforeEach(() => {
	setRetrying(false);
	setReason(null);
});

afterEach(() => {
	if (mounted) unmount(mounted);
	mounted = null;
	document.body.innerHTML = '';
	vi.clearAllMocks();
});

describe('ReplicaFailedOverlay', () => {
	it('renders the blocking dialog, its roles, and the block copy verbatim', () => {
		mounted = mount(ReplicaFailedOverlay, { target: document.body });
		flushSync();

		const el = document.querySelector('[data-testid="replica-blocked"]');
		expect(el).not.toBeNull();
		expect(el?.getAttribute('role')).toBe('alertdialog');
		expect(el?.getAttribute('aria-modal')).toBe('true');
		const labelId = el?.getAttribute('aria-labelledby');
		expect(labelId).toBeTruthy();
		expect(document.getElementById(labelId!)?.textContent?.trim()).toBe('Model out of sync');
		expect(el?.textContent?.replace(/\s+/g, ' ')).toContain(
			'The local copy of the model could not be rebuilt from the server. Your uncommitted edits are kept.'
		);
	});

	it('renders the reason beneath its heading when there is one, and none otherwise', () => {
		mounted = mount(ReplicaFailedOverlay, { target: document.body });
		flushSync();
		expect(document.querySelector('[data-testid="replica-blocked-reason"]')).toBeNull();

		setReason('the engine frame did not load');
		flushSync();

		const reason = document.querySelector('[data-testid="replica-blocked-reason"]');
		expect(reason?.textContent?.trim()).toBe('the engine frame did not load');
	});

	it('shows Retry enabled, and calls retryReplica on click', () => {
		mounted = mount(ReplicaFailedOverlay, { target: document.body });
		flushSync();

		const button = document.querySelector<HTMLButtonElement>('button');
		expect(button?.textContent?.trim()).toBe('Retry');
		expect(button?.disabled).toBe(false);

		button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		flushSync();

		expect(retryReplica).toHaveBeenCalledOnce();
	});

	it('shows Retrying…, disabled, while isReplicaRetrying()', () => {
		setRetrying(true);
		mounted = mount(ReplicaFailedOverlay, { target: document.body });
		flushSync();

		const button = document.querySelector<HTMLButtonElement>('button');
		expect(button?.textContent?.trim()).toBe('Retrying…');
		expect(button?.disabled).toBe(true);
	});

	it('focuses the Retry button on mount', () => {
		mounted = mount(ReplicaFailedOverlay, { target: document.body });
		flushSync();

		const button = document.querySelector('button');
		expect(document.activeElement).toBe(button);
	});

	it('moves focus back to Retry once a retry lands back on failed', () => {
		mounted = mount(ReplicaFailedOverlay, { target: document.body });
		flushSync();
		const button = document.querySelector<HTMLButtonElement>('button');
		expect(document.activeElement).toBe(button);

		setRetrying(true);
		flushSync();
		expect(button?.disabled).toBe(true);
		// A real browser would already have moved focus off a button that just
		// went disabled; move it away by hand here to prove the effect below
		// brings it BACK, rather than it having never left.
		document.body.focus();
		expect(document.activeElement).not.toBe(button);

		setRetrying(false);
		flushSync();

		expect(button?.disabled).toBe(false);
		expect(document.activeElement).toBe(button);
	});
});
