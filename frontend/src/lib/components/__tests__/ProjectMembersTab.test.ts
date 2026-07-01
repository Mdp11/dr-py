import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import ProjectMembersTab from '../admin/ProjectMembersTab.svelte';
import { ApiError } from '$lib/api/errors';

const listProjects = vi.fn();
vi.mock('$lib/api/projects', () => ({
	listProjects: (...a: unknown[]) => listProjects(...a)
}));

const listMembers = vi.fn();
const addMember = vi.fn();
const removeMember = vi.fn();
const listUsers = vi.fn();
vi.mock('$lib/api/admin', () => ({
	listMembers: (...a: unknown[]) => listMembers(...a),
	addMember: (...a: unknown[]) => addMember(...a),
	removeMember: (...a: unknown[]) => removeMember(...a),
	listUsers: (...a: unknown[]) => listUsers(...a)
}));

afterEach(() => {
	document.body.innerHTML = '';
	vi.clearAllMocks();
});

function clickResult(email: string): void {
	const btn = [...document.querySelectorAll('button')].find(
		(b) => b.textContent?.trim() === email
	) as HTMLButtonElement;
	btn.click();
}

describe('ProjectMembersTab', () => {
	it('lists members when a project is selected on mount', async () => {
		listProjects.mockResolvedValue([{ id: 'p1', name: 'Alpha', role: 'owner' }]);
		listMembers.mockResolvedValue([
			{ user_id: 'u1', email: 'owner@x', role: 'owner' },
			{ user_id: 'u2', email: 'editor@x', role: 'editor' }
		]);
		const c = mount(ProjectMembersTab, { target: document.body });
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
		expect(document.body.textContent).toContain('owner@x');
		expect(document.body.textContent).toContain('editor@x');
		unmount(c);
	});

	it('shows error message when the initial listProjects fetch fails', async () => {
		listProjects.mockRejectedValue(new ApiError(500, { detail: 'Server error' }, 'Server error'));
		const c = mount(ProjectMembersTab, { target: document.body });
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
		expect(document.body.textContent).toContain('Server error');
		unmount(c);
	});

	it('shows error message when addMember returns 404 (unknown user)', async () => {
		listProjects.mockResolvedValue([{ id: 'p1', name: 'Alpha', role: 'owner' }]);
		listMembers.mockResolvedValue([{ user_id: 'u1', email: 'owner@x', role: 'owner' }]);
		listUsers.mockResolvedValue([
			{ id: 'user-nobody', email: 'nobody@x', is_admin: false, is_active: true }
		]);
		addMember.mockRejectedValue(new ApiError(404, { detail: 'User not found' }, 'User not found'));
		const c = mount(ProjectMembersTab, { target: document.body });
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
		const searchInput = document.querySelector(
			'input[placeholder="Search user by email…"]'
		) as HTMLInputElement;
		searchInput.value = 'nobody';
		searchInput.dispatchEvent(new Event('input', { bubbles: true }));
		await new Promise((r) => setTimeout(r, 300));
		flushSync();
		clickResult('nobody@x');
		flushSync();
		document
			.querySelector('form')!
			.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
		expect(document.body.textContent).toContain('User not found');
		unmount(c);
	});

	it('shows error message when removeMember returns 422 (last owner)', async () => {
		listProjects.mockResolvedValue([{ id: 'p1', name: 'Alpha', role: 'owner' }]);
		listMembers.mockResolvedValue([{ user_id: 'u1', email: 'owner@x', role: 'owner' }]);
		removeMember.mockRejectedValue(
			new ApiError(422, { detail: 'Cannot remove last owner' }, 'Cannot remove last owner')
		);
		const c = mount(ProjectMembersTab, { target: document.body });
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
		const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
		const removeBtn = [...document.querySelectorAll('button')].find(
			(b) => b.textContent?.trim() === 'remove'
		) as HTMLButtonElement;
		removeBtn.click();
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
		expect(document.body.textContent).toContain('Cannot remove last owner');
		expect(document.body.textContent).toContain('owner@x');
		confirmSpy.mockRestore();
		unmount(c);
	});
});

describe('ProjectMembersTab user picker', () => {
	it('searches users and posts the selected real user_id (no "unknown user")', async () => {
		listProjects.mockResolvedValue([{ id: 'p1', name: 'Alpha', role: 'owner' }]);
		listMembers.mockResolvedValue([{ user_id: 'u1', email: 'owner@x', role: 'owner' }]);
		listUsers.mockResolvedValue([
			{ id: 'user-ann', email: 'ann@example.com', is_admin: false, is_active: true }
		]);
		addMember.mockResolvedValue(undefined);

		const c = mount(ProjectMembersTab, { target: document.body });
		await new Promise((r) => setTimeout(r, 0));
		flushSync();

		const searchInput = document.querySelector(
			'input[placeholder="Search user by email…"]'
		) as HTMLInputElement;
		searchInput.value = 'ann';
		searchInput.dispatchEvent(new Event('input', { bubbles: true }));
		await new Promise((r) => setTimeout(r, 300));
		flushSync();

		expect(listUsers).toHaveBeenCalledWith('ann');
		clickResult('ann@example.com');
		flushSync();

		const addBtn = [...document.querySelectorAll('button')].find(
			(b) => b.textContent?.trim() === 'Add member'
		) as HTMLButtonElement;
		addBtn.click();
		await new Promise((r) => setTimeout(r, 0));
		flushSync();

		expect(addMember).toHaveBeenCalledWith('p1', 'user-ann', 'editor');
		expect(addMember).not.toHaveBeenCalledWith('p1', 'ann', 'editor');
		unmount(c);
	});

	it('remove member confirms before calling removeMember', async () => {
		listProjects.mockResolvedValue([{ id: 'p1', name: 'Alpha', role: 'owner' }]);
		listMembers.mockResolvedValue([{ user_id: 'u1', email: 'owner@x', role: 'owner' }]);

		const c = mount(ProjectMembersTab, { target: document.body });
		await new Promise((r) => setTimeout(r, 0));
		flushSync();

		const findRemoveBtn = () =>
			[...document.querySelectorAll('button')].find(
				(b) => b.textContent?.trim() === 'remove'
			) as HTMLButtonElement;

		const confirmSpy = vi.spyOn(window, 'confirm');

		confirmSpy.mockReturnValueOnce(false);
		findRemoveBtn().click();
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
		expect(removeMember).not.toHaveBeenCalled();

		confirmSpy.mockReturnValueOnce(true);
		removeMember.mockResolvedValue(undefined);
		findRemoveBtn().click();
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
		expect(removeMember).toHaveBeenCalledWith('p1', 'u1');

		confirmSpy.mockRestore();
		unmount(c);
	});
});
