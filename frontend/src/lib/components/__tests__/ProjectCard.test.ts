import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import ProjectCard from '../projects/ProjectCard.svelte';

// Mutable flag so individual tests can flip admin on/off without re-mocking
// (mirrors ProjectsPage.test.ts's convention for $lib/state).
let adminFlag = false;
vi.mock('$lib/state', async (orig) => ({ ...(await orig()), isAdmin: () => adminFlag }));

const deleteProject = vi.fn();
const cloneProject = vi.fn();
vi.mock('$lib/api/projects', () => ({
	deleteProject: (...a: unknown[]) => deleteProject(...a),
	cloneProject: (...a: unknown[]) => cloneProject(...a)
}));

const project = { id: 'p1', name: 'Alpha', role: 'viewer' as const };

async function settle() {
	await new Promise((r) => setTimeout(r, 0));
	flushSync();
}

function findButton(name: RegExp): HTMLButtonElement | undefined {
	return [...document.querySelectorAll('button')].find((b) => name.test(b.textContent ?? ''));
}

beforeEach(() => {
	adminFlag = false;
	deleteProject.mockClear();
	cloneProject.mockClear();
	deleteProject.mockResolvedValue(undefined);
	cloneProject.mockResolvedValue({ id: 'p2', name: 'x (copy)', role: 'owner' });
});
afterEach(() => {
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

describe('ProjectCard', () => {
	it('opens on name click', () => {
		const onOpen = vi.fn();
		const c = mount(ProjectCard, {
			target: document.body,
			props: { project, onOpen, onChanged: vi.fn() }
		});
		flushSync();
		const nameEl = [...document.querySelectorAll('*')].find(
			(el) => el.textContent?.trim() === 'Alpha' && el.children.length === 0
		) as HTMLElement;
		nameEl.click();
		expect(onOpen).toHaveBeenCalledWith('p1');
		unmount(c);
	});

	it('clone is available to any member and refreshes', async () => {
		const onChanged = vi.fn();
		const c = mount(ProjectCard, {
			target: document.body,
			props: { project, onOpen: vi.fn(), onChanged }
		});
		flushSync();
		const cloneBtn = findButton(/clone/i)!;
		cloneBtn.click();
		await settle();
		expect(cloneProject).toHaveBeenCalledWith('p1');
		expect(onChanged).toHaveBeenCalled();
		unmount(c);
	});

	it('delete button is hidden for non-admins', () => {
		const c = mount(ProjectCard, {
			target: document.body,
			props: { project, onOpen: vi.fn(), onChanged: vi.fn() }
		});
		flushSync();
		expect(findButton(/delete/i)).toBeUndefined();
		unmount(c);
	});

	it('admin delete confirms then calls api', async () => {
		adminFlag = true;
		const onChanged = vi.fn();
		const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
		const c = mount(ProjectCard, {
			target: document.body,
			props: { project, onOpen: vi.fn(), onChanged }
		});
		flushSync();
		const deleteBtn = findButton(/delete/i)!;
		deleteBtn.click();
		await settle();
		expect(confirm).toHaveBeenCalled();
		expect(deleteProject).toHaveBeenCalledWith('p1');
		expect(onChanged).toHaveBeenCalled();
		unmount(c);
	});

	it('admin delete aborts when not confirmed', async () => {
		adminFlag = true;
		vi.spyOn(window, 'confirm').mockReturnValue(false);
		const c = mount(ProjectCard, {
			target: document.body,
			props: { project, onOpen: vi.fn(), onChanged: vi.fn() }
		});
		flushSync();
		const deleteBtn = findButton(/delete/i)!;
		deleteBtn.click();
		await settle();
		expect(deleteProject).not.toHaveBeenCalled();
		unmount(c);
	});
});
