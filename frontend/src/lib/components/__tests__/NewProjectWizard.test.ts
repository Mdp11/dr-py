import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import NewProjectWizard from '../projects/NewProjectWizard.svelte';
import { ValidationError } from '$lib/api/errors';
import { resetJourney } from '$lib/state/open-journey';
import { getActiveProgress, resetProgress } from '$lib/state/progress.svelte';

const createProject = vi.fn();
vi.mock('$lib/api/projects', () => ({ createProject: (...a: unknown[]) => createProject(...a) }));

afterEach(() => {
	resetJourney();
	resetProgress();
	document.body.innerHTML = '';
	vi.clearAllMocks();
});

function setFile(input: HTMLInputElement, file: File) {
	Object.defineProperty(input, 'files', { value: [file], configurable: true });
	input.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('NewProjectWizard', () => {
	it('creates a project with name + metamodel only (model optional)', async () => {
		createProject.mockResolvedValue({ id: 'pX', name: 'W', role: 'owner', skipped_artifacts: [] });
		const onCreated = vi.fn();
		const c = mount(NewProjectWizard, { target: document.body, props: { open: true, onCreated } });
		flushSync();
		const name = document.querySelector('input[name="project-name"]') as HTMLInputElement;
		name.value = 'W';
		name.dispatchEvent(new Event('input', { bubbles: true }));
		setFile(
			document.querySelector('input[data-testid="mm-input"]') as HTMLInputElement,
			new File(['types: []'], 'mm.yaml')
		);
		flushSync();
		document
			.querySelector('form')!
			.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await Promise.resolve();
		await Promise.resolve();
		expect(createProject).toHaveBeenCalledWith(
			expect.objectContaining({ name: 'W', metamodel: expect.any(File) }),
			expect.any(Function)
		);
		expect(onCreated).toHaveBeenCalledWith('pX');
		unmount(c);
	});

	it('shows an error and does not call onCreated when the backend returns 422', async () => {
		createProject.mockRejectedValue(
			new ValidationError(422, { detail: 'invalid metamodel' }, 'invalid metamodel')
		);
		const onCreated = vi.fn();
		const c = mount(NewProjectWizard, { target: document.body, props: { open: true, onCreated } });
		flushSync();
		const name = document.querySelector('input[name="project-name"]') as HTMLInputElement;
		name.value = 'Bad';
		name.dispatchEvent(new Event('input', { bubbles: true }));
		setFile(
			document.querySelector('input[data-testid="mm-input"]') as HTMLInputElement,
			new File(['bad'], 'bad.yaml')
		);
		flushSync();
		document
			.querySelector('form')!
			.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await Promise.resolve();
		await Promise.resolve();
		flushSync();
		expect(onCreated).not.toHaveBeenCalled();
		expect(document.body.textContent).toMatch(/could not create|invalid metamodel/i);
		unmount(c);
	});

	it('tears the progress bar down when creation fails', async () => {
		createProject.mockRejectedValue(new ValidationError(422, { detail: 'nope' }, 'nope'));
		const c = mount(NewProjectWizard, {
			target: document.body,
			props: { open: true, onCreated: vi.fn() }
		});
		flushSync();
		const name = document.querySelector('input[name="project-name"]') as HTMLInputElement;
		name.value = 'W';
		name.dispatchEvent(new Event('input', { bubbles: true }));
		setFile(
			document.querySelector('input[data-testid="mm-input"]') as HTMLInputElement,
			new File(['types: []'], 'mm.yaml')
		);
		flushSync();
		document
			.querySelector('form')!
			.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await Promise.resolve();
		await Promise.resolve();
		flushSync();
		expect(getActiveProgress()).toBeNull();
		unmount(c);
	});

	it('disables submit until a name and a metamodel are provided', async () => {
		const c = mount(NewProjectWizard, {
			target: document.body,
			props: { open: true, onCreated: vi.fn() }
		});
		flushSync();
		const submit = document.querySelector('button[type="submit"]') as HTMLButtonElement;
		expect(submit.disabled).toBe(true);
		unmount(c);
	});

	it('sends the artifacts bundle part and reports skipped artifacts before navigating', async () => {
		createProject.mockResolvedValue({
			id: 'p9',
			name: 'P',
			role: 'owner',
			skipped_artifacts: [{ bundle_id: 'd1', reason: 'unknown kind' }]
		});
		const onCreated = vi.fn();
		const c = mount(NewProjectWizard, { target: document.body, props: { open: true, onCreated } });
		flushSync();
		const name = document.querySelector('input[name="project-name"]') as HTMLInputElement;
		name.value = 'P';
		name.dispatchEvent(new Event('input', { bubbles: true }));
		setFile(
			document.querySelector('input[data-testid="mm-input"]') as HTMLInputElement,
			new File(['types: []'], 'mm.yaml')
		);
		setFile(
			document.querySelector('input[data-testid="artifacts-input"]') as HTMLInputElement,
			new File(['{}'], 'b.json')
		);
		flushSync();
		document
			.querySelector('form')!
			.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await Promise.resolve();
		await Promise.resolve();
		flushSync();
		expect(createProject.mock.calls[0][0].artifacts).toBeInstanceOf(File);
		// navigation is DEFERRED: the warning panel shows first
		expect(onCreated).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain('unknown kind');
		document.body.querySelector<HTMLButtonElement>('[data-testid="wizard-open-anyway"]')!.click();
		await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith('p9'));
		unmount(c);
	});

	it('navigates straight through when nothing was skipped', async () => {
		createProject.mockResolvedValue({
			id: 'p9',
			name: 'P',
			role: 'owner',
			skipped_artifacts: []
		});
		const onCreated = vi.fn();
		const c = mount(NewProjectWizard, { target: document.body, props: { open: true, onCreated } });
		flushSync();
		const name = document.querySelector('input[name="project-name"]') as HTMLInputElement;
		name.value = 'P';
		name.dispatchEvent(new Event('input', { bubbles: true }));
		setFile(
			document.querySelector('input[data-testid="mm-input"]') as HTMLInputElement,
			new File(['types: []'], 'mm.yaml')
		);
		flushSync();
		document
			.querySelector('form')!
			.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		await vi.waitFor(() => expect(onCreated).toHaveBeenCalledWith('p9'));
		unmount(c);
	});
});
