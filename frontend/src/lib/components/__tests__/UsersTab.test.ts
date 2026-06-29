import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import UsersTab from '../admin/UsersTab.svelte';
import { ApiError } from '$lib/api/errors';

const listUsers = vi.fn();
const createUser = vi.fn();
const patchUser = vi.fn();
const deleteUser = vi.fn();
vi.mock('$lib/api/admin', () => ({
	listUsers: (...a: unknown[]) => listUsers(...a),
	createUser: (...a: unknown[]) => createUser(...a),
	patchUser: (...a: unknown[]) => patchUser(...a),
	deleteUser: (...a: unknown[]) => deleteUser(...a)
}));

afterEach(() => {
	vi.useRealTimers(); // restore if a test left fake timers active
	document.body.innerHTML = '';
	vi.clearAllMocks();
});

describe('UsersTab', () => {
	it('lists users on mount', async () => {
		listUsers.mockResolvedValue([{ id: 'u1', email: 'a@x', is_admin: true, is_active: true }]);
		const c = mount(UsersTab, { target: document.body });
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
		expect(document.body.textContent).toContain('a@x');
		unmount(c);
	});

	it('creates a user from the form', async () => {
		listUsers.mockResolvedValue([]);
		createUser.mockResolvedValue({ id: 'u9', email: 'new@x', is_admin: false, is_active: true });
		const c = mount(UsersTab, { target: document.body });
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
		const email = document.querySelector('input[name="new-email"]') as HTMLInputElement;
		email.value = 'new@x';
		email.dispatchEvent(new Event('input', { bubbles: true }));
		const pw = document.querySelector('input[name="new-password"]') as HTMLInputElement;
		pw.value = 'secret12';
		pw.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		document
			.querySelector('form[data-testid="new-user-form"]')!
			.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await Promise.resolve();
		await Promise.resolve();
		expect(createUser).toHaveBeenCalledWith({
			email: 'new@x',
			password: 'secret12',
			is_admin: false
		});
		unmount(c);
	});

	it('debounces search input: rapid keystrokes coalesce into a single refresh', async () => {
		// onMount refresh
		listUsers.mockResolvedValue([{ id: 'u1', email: 'a@x', is_admin: false, is_active: true }]);
		const c = mount(UsersTab, { target: document.body });
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
		const callsAfterMount = listUsers.mock.calls.length; // should be 1

		vi.useFakeTimers();
		const searchInput = document.querySelector('input[type="search"]') as HTMLInputElement;

		// Three rapid keystrokes — each clears the previous debounce timer
		for (const val of ['a', 'ab', 'abc']) {
			searchInput.value = val;
			searchInput.dispatchEvent(new Event('input', { bubbles: true }));
		}
		flushSync();

		// No search refresh has fired yet (timer not elapsed)
		expect(listUsers).toHaveBeenCalledTimes(callsAfterMount);

		// Fire the debounce; provide a result for the coalesced search
		listUsers.mockResolvedValue([{ id: 'u2', email: 'ab@x', is_admin: false, is_active: true }]);
		vi.advanceTimersByTime(250);

		vi.useRealTimers();
		await new Promise((r) => setTimeout(r, 0));
		flushSync();

		// Exactly one additional call — for the final query 'abc'
		expect(listUsers).toHaveBeenCalledTimes(callsAfterMount + 1);
		expect(listUsers).toHaveBeenLastCalledWith('abc');
		unmount(c);
	});

	it('stale-response guard: a slow earlier result does not overwrite a newer one', async () => {
		let resolveSlowSearch!: (
			v: { id: string; email: string; is_admin: boolean; is_active: boolean }[]
		) => void;
		const slowPromise = new Promise<
			{ id: string; email: string; is_admin: boolean; is_active: boolean }[]
		>((r) => {
			resolveSlowSearch = r;
		});

		listUsers
			.mockResolvedValueOnce([]) // onMount
			.mockReturnValueOnce(slowPromise) // search 'a' (slow)
			.mockResolvedValueOnce([{ id: 'u2', email: 'fast@x', is_admin: false, is_active: true }]); // search 'ab'

		const c = mount(UsersTab, { target: document.body });
		await new Promise((r) => setTimeout(r, 0));
		flushSync();

		vi.useFakeTimers();
		const searchInput = document.querySelector('input[type="search"]') as HTMLInputElement;

		// Fire search for 'a'
		searchInput.value = 'a';
		searchInput.dispatchEvent(new Event('input', { bubbles: true }));
		vi.advanceTimersByTime(250);

		// Fire search for 'ab' before 'a' resolves
		searchInput.value = 'ab';
		searchInput.dispatchEvent(new Event('input', { bubbles: true }));
		vi.advanceTimersByTime(250);

		vi.useRealTimers();
		await new Promise((r) => setTimeout(r, 0));
		flushSync();

		// 'ab' results are visible
		expect(document.body.textContent).toContain('fast@x');

		// Resolve the stale 'a' search — its results must NOT overwrite 'ab'
		resolveSlowSearch([{ id: 'u1', email: 'slow@x', is_admin: false, is_active: true }]);
		await new Promise((r) => setTimeout(r, 0));
		flushSync();

		expect(document.body.textContent).toContain('fast@x');
		expect(document.body.textContent).not.toContain('slow@x');
		unmount(c);
	});

	it('shows error message when the initial listUsers fetch fails', async () => {
		listUsers.mockRejectedValue(
			new ApiError(500, { detail: 'Internal server error' }, 'Internal server error')
		);
		const c = mount(UsersTab, { target: document.body });
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
		expect(document.body.textContent).toContain('Internal server error');
		unmount(c);
	});

	it('shows error message and keeps user listed when delete fails with 409', async () => {
		listUsers.mockResolvedValue([{ id: 'u1', email: 'a@x', is_admin: false, is_active: true }]);
		deleteUser.mockRejectedValue(
			new ApiError(409, { detail: 'Cannot delete last admin' }, 'Cannot delete last admin')
		);
		const c = mount(UsersTab, { target: document.body });
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
		expect(document.body.textContent).toContain('a@x');
		const deleteBtn = [...document.querySelectorAll('button')].find(
			(b) => b.textContent?.trim() === 'delete'
		) as HTMLButtonElement;
		deleteBtn.click();
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
		expect(document.body.textContent).toContain('Cannot delete last admin');
		expect(document.body.textContent).toContain('a@x');
		unmount(c);
	});
});
