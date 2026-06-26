import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import NewProjectWizard from '../projects/NewProjectWizard.svelte';
import { ValidationError } from '$lib/api/errors';

const createProject = vi.fn();
vi.mock('$lib/api/projects', () => ({ createProject: (...a: unknown[]) => createProject(...a) }));

afterEach(() => {
	document.body.innerHTML = '';
	vi.clearAllMocks();
});

function setFile(input: HTMLInputElement, file: File) {
	Object.defineProperty(input, 'files', { value: [file], configurable: true });
	input.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('NewProjectWizard', () => {
	it('creates a project with name + metamodel only (model optional)', async () => {
		createProject.mockResolvedValue({ id: 'pX', name: 'W', role: 'owner' });
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
			expect.objectContaining({ name: 'W', metamodel: expect.any(File) })
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
});
