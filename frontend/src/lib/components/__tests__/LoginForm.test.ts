import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import LoginForm from '../auth/LoginForm.svelte';

const signIn = vi.fn();
const goto = vi.fn();
vi.mock('$lib/state', () => ({ signIn: (...a: unknown[]) => signIn(...a) }));
vi.mock('$app/navigation', () => ({ goto: (...a: unknown[]) => goto(...a) }));

afterEach(() => {
	document.body.innerHTML = '';
	vi.clearAllMocks();
});

describe('LoginForm', () => {
	it('signs in and navigates on success', async () => {
		signIn.mockResolvedValue(undefined);
		const c = mount(LoginForm, { target: document.body });
		flushSync();
		(document.querySelector('input[type="email"]') as HTMLInputElement).value = 'a@x';
		(document.querySelector('input[type="email"]') as HTMLInputElement).dispatchEvent(
			new Event('input', { bubbles: true })
		);
		(document.querySelector('input[type="password"]') as HTMLInputElement).value = 'pw';
		(document.querySelector('input[type="password"]') as HTMLInputElement).dispatchEvent(
			new Event('input', { bubbles: true })
		);
		flushSync();
		document
			.querySelector('form')!
			.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await Promise.resolve();
		await Promise.resolve();
		expect(signIn).toHaveBeenCalledWith('a@x', 'pw');
		expect(goto).toHaveBeenCalledWith('/projects');
		unmount(c);
	});

	it('shows an error message when sign-in fails', async () => {
		signIn.mockRejectedValue(new Error('invalid credentials'));
		const c = mount(LoginForm, { target: document.body });
		flushSync();
		document
			.querySelector('form')!
			.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await Promise.resolve();
		await Promise.resolve();
		flushSync();
		expect(document.body.textContent).toContain('Invalid');
		expect(goto).not.toHaveBeenCalled();
		unmount(c);
	});
});
