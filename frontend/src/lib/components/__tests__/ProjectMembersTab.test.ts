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
vi.mock('$lib/api/admin', () => ({
	listMembers: (...a: unknown[]) => listMembers(...a),
	addMember: (...a: unknown[]) => addMember(...a),
	removeMember: (...a: unknown[]) => removeMember(...a)
}));

afterEach(() => {
	document.body.innerHTML = '';
	vi.clearAllMocks();
});

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
		addMember.mockRejectedValue(new ApiError(404, { detail: 'User not found' }, 'User not found'));
		const c = mount(ProjectMembersTab, { target: document.body });
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
		const userIdInput = document.querySelector('input[placeholder="User id"]') as HTMLInputElement;
		userIdInput.value = 'nobody';
		userIdInput.dispatchEvent(new Event('input', { bubbles: true }));
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
		const removeBtn = [...document.querySelectorAll('button')].find(
			(b) => b.textContent?.trim() === 'remove'
		) as HTMLButtonElement;
		removeBtn.click();
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
		expect(document.body.textContent).toContain('Cannot remove last owner');
		expect(document.body.textContent).toContain('owner@x');
		unmount(c);
	});
});
