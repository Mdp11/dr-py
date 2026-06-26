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
