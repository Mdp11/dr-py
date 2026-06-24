import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import SettingsDialog from '../SettingsDialog.svelte';

// Mock the settings API so no network is needed.
vi.mock('$lib/api/settings', () => ({
	getSettings: vi.fn(async () => ({ strict_mode: false })),
	updateSettings: vi.fn(async (v: boolean) => ({ strict_mode: v }))
}));
import { getSettings, updateSettings } from '$lib/api/settings';

vi.mock('$lib/state', async (orig) => {
	const actual = await orig<typeof import('$lib/state')>();
	return {
		...actual,
		getRole: vi.fn(() => 'owner'),
		setStrictMode: vi.fn()
	};
});

import { getRole, setStrictMode } from '$lib/state';

afterEach(() => {
	document.body.innerHTML = '';
	vi.clearAllMocks();
});

/** Wait up to ms for predicate to be truthy, polling every 10 ms. */
async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > deadline) throw new Error('waitFor timed out');
		await new Promise((r) => setTimeout(r, 10));
	}
}

function bodyText(): string {
	return document.body.textContent ?? '';
}

describe('SettingsDialog — owner', () => {
	it('fetches settings on open and enables the switch for owners', async () => {
		(getRole as ReturnType<typeof vi.fn>).mockReturnValue('owner');
		(getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ strict_mode: false });

		const c = mount(SettingsDialog, { target: document.body, props: { open: true } });
		flushSync();

		await waitFor(() => (getSettings as ReturnType<typeof vi.fn>).mock.calls.length > 0);
		await waitFor(() => document.querySelector('[role="switch"]') !== null);
		flushSync();

		const sw = document.querySelector('[role="switch"]') as HTMLButtonElement | null;
		expect(sw).not.toBeNull();
		expect(sw!.disabled).toBe(false);

		unmount(c);
	});

	it('toggling the switch calls PATCH /settings with { strict_mode: true } and updates state', async () => {
		(getRole as ReturnType<typeof vi.fn>).mockReturnValue('owner');
		(getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ strict_mode: false });
		(updateSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ strict_mode: true });

		const c = mount(SettingsDialog, { target: document.body, props: { open: true } });
		flushSync();

		await waitFor(() => document.querySelector('[role="switch"]') !== null);
		flushSync();

		const sw = document.querySelector('[role="switch"]') as HTMLButtonElement;
		sw.click();

		await waitFor(() => (updateSettings as ReturnType<typeof vi.fn>).mock.calls.length > 0);

		// Verify PATCH body was { strict_mode: true }
		expect(updateSettings).toHaveBeenCalledWith(true);

		// Verify the checkout state was updated
		await waitFor(() => (setStrictMode as ReturnType<typeof vi.fn>).mock.calls.length > 0);
		expect(setStrictMode).toHaveBeenCalledWith(true);

		unmount(c);
	});
});

describe('SettingsDialog — viewer', () => {
	it('shows disabled switch and owner-only message for non-owners', async () => {
		(getRole as ReturnType<typeof vi.fn>).mockReturnValue('viewer');
		(getSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ strict_mode: false });

		const c = mount(SettingsDialog, { target: document.body, props: { open: true } });
		flushSync();

		await waitFor(() => (getSettings as ReturnType<typeof vi.fn>).mock.calls.length > 0);
		await waitFor(() => document.querySelector('[role="switch"]') !== null);
		flushSync();

		const sw = document.querySelector('[role="switch"]') as HTMLButtonElement | null;
		expect(sw).not.toBeNull();
		expect(sw!.disabled).toBe(true);

		expect(/only an owner/i.test(bodyText())).toBe(true);

		unmount(c);
	});
});
