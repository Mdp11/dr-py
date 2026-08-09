import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';
import NewProjectWizard from '../projects/NewProjectWizard.svelte';
import NewProjectWizardHost from './NewProjectWizardHost.svelte';
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

	// Regression for review finding #5: closing used to reset only
	// artifacts/skipped/createdId, leaving name/metamodel/model/view showing
	// the PREVIOUS attempt on reopen (with the artifacts slot alone blank —
	// an inconsistent, confusing state). Drive an actual close→reopen cycle
	// via NewProjectWizardHost (see its own comment for why a host is needed:
	// `open` is a plain $bindable prop, not a store, so a top-level `mount()`
	// cannot toggle it from the test directly).
	it('resets name and every file slot on close, not just the artifacts slot', async () => {
		const onCreated = vi.fn();
		const c = mount(NewProjectWizardHost, { target: document.body, props: { onCreated } });
		flushSync();

		const name = document.querySelector('input[name="project-name"]') as HTMLInputElement;
		name.value = 'Abandoned';
		name.dispatchEvent(new Event('input', { bubbles: true }));
		setFile(
			document.querySelector('input[data-testid="mm-input"]') as HTMLInputElement,
			new File(['types: []'], 'mm.yaml')
		);
		flushSync();
		// The FileSlot renders the picked filename once a file is set.
		expect(document.body.textContent).toContain('mm.yaml');

		const toggle = document.body.querySelector<HTMLButtonElement>(
			'[data-testid="host-toggle-open"]'
		)!;
		toggle.click(); // close
		flushSync();
		toggle.click(); // reopen
		flushSync();

		const reopenedName = document.querySelector('input[name="project-name"]') as HTMLInputElement;
		expect(reopenedName.value).toBe('');
		expect(document.body.textContent).not.toContain('mm.yaml');
		unmount(c);
	});

	// Companion to the close-reset regression above: the reset cleared the five
	// inputs plus skipped/createdId but left `error` (and `pending`) behind, so
	// a failed attempt's error message reappeared on a fresh reopen.
	it("does not resurrect the previous attempt's error message on reopen", async () => {
		createProject.mockRejectedValue(
			new ValidationError(422, { detail: 'invalid metamodel' }, 'invalid metamodel')
		);
		const c = mount(NewProjectWizardHost, { target: document.body, props: { onCreated: vi.fn() } });
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
		await vi.waitFor(() =>
			expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
				'invalid metamodel'
			)
		);

		const toggle = document.body.querySelector<HTMLButtonElement>(
			'[data-testid="host-toggle-open"]'
		)!;
		toggle.click(); // close
		flushSync();
		toggle.click(); // reopen
		flushSync();

		expect(document.body.querySelector('[role="alert"]')).toBeNull();
		unmount(c);
	});

	// Review findings on the close-reset fix above: a createProject still in
	// flight when the dialog closes must be ABANDONED — its settlement may
	// neither write error/skipped/createdId onto the fresh form nor navigate
	// via onCreated, and its `pending` must not freeze a reopened wizard.
	it('a submit that fails after the dialog closed leaves the reopened wizard pristine and unfrozen', async () => {
		let rejectCreate!: (e: unknown) => void;
		createProject.mockImplementation(
			() =>
				new Promise((_, rej) => {
					rejectCreate = rej;
				})
		);
		const c = mount(NewProjectWizardHost, { target: document.body, props: { onCreated: vi.fn() } });
		flushSync();
		const name = document.querySelector('input[name="project-name"]') as HTMLInputElement;
		name.value = 'Slow';
		name.dispatchEvent(new Event('input', { bubbles: true }));
		setFile(
			document.querySelector('input[data-testid="mm-input"]') as HTMLInputElement,
			new File(['types: []'], 'mm.yaml')
		);
		flushSync();
		document
			.querySelector('form')!
			.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		flushSync();

		const toggle = document.body.querySelector<HTMLButtonElement>(
			'[data-testid="host-toggle-open"]'
		)!;
		toggle.click(); // close while the upload is in flight
		flushSync();
		toggle.click(); // reopen immediately, before it settles
		flushSync();

		// The abandoned request's `pending` must not freeze the fresh form
		// (Cancel and every FileSlot render disabled={pending}; the hidden
		// file inputs themselves are never disabled, so assert on Cancel).
		const cancel = [...document.querySelectorAll('button')].find(
			(b) => b.textContent?.trim() === 'Cancel'
		)!;
		expect(cancel.disabled).toBe(false);

		// The late failure must not surface on the fresh form either.
		rejectCreate(new ValidationError(422, { detail: 'invalid metamodel' }, 'invalid metamodel'));
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
		expect(document.body.querySelector('[role="alert"]')).toBeNull();
		unmount(c);
	});

	it('a submit that succeeds after the dialog closed does not navigate', async () => {
		let resolveCreate!: (v: unknown) => void;
		createProject.mockImplementation(
			() =>
				new Promise((res) => {
					resolveCreate = res;
				})
		);
		const onCreated = vi.fn();
		const c = mount(NewProjectWizardHost, { target: document.body, props: { onCreated } });
		flushSync();
		const name = document.querySelector('input[name="project-name"]') as HTMLInputElement;
		name.value = 'Slow';
		name.dispatchEvent(new Event('input', { bubbles: true }));
		setFile(
			document.querySelector('input[data-testid="mm-input"]') as HTMLInputElement,
			new File(['types: []'], 'mm.yaml')
		);
		flushSync();
		document
			.querySelector('form')!
			.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		flushSync();

		document.body.querySelector<HTMLButtonElement>('[data-testid="host-toggle-open"]')!.click(); // close while in flight
		flushSync();

		resolveCreate({ id: 'p9', name: 'Slow', role: 'owner', skipped_artifacts: [] });
		await new Promise((r) => setTimeout(r, 0));
		flushSync();
		// The user cancelled this attempt: no navigation into the project...
		expect(onCreated).not.toHaveBeenCalled();
		// ...and the journey bar is torn down, not left running forever.
		expect(getActiveProgress()).toBeNull();
		unmount(c);
	});

	// Regression for review finding #7 (hygiene #2): the "Open project" click
	// handler is fire-and-forget; a rejecting `onCreated` must not become an
	// unhandled promise rejection. Deliberately NOT a `vi.fn()` mock: Vitest's
	// spy instrumentation attaches its own internal `.then`/`.catch` to record
	// `mock.results`, which would swallow the rejection regardless of whether
	// the component itself handles it — masking exactly the bug this test
	// exists to catch. A plain closure has no such side channel, so an
	// uncaught rejection here can only come from the component's own handler,
	// and Vitest fails the overall run (nonzero exit, an "Unhandled Errors"
	// section) on an uncaught one — the absence of that IS the assertion.
	it('does not produce an unhandled rejection when onCreated rejects from the skipped-artifacts panel', async () => {
		createProject.mockResolvedValue({
			id: 'p9',
			name: 'P',
			role: 'owner',
			skipped_artifacts: [{ bundle_id: 'd1', reason: 'unknown kind' }]
		});
		let calledWith: string | null = null;
		const onCreated = (id: string): Promise<void> => {
			calledWith = id;
			return Promise.reject(new Error('navigation failed'));
		};
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
		await vi.waitFor(() =>
			expect(
				document.body.querySelector<HTMLButtonElement>('[data-testid="wizard-open-anyway"]')
			).not.toBeNull()
		);
		document.body.querySelector<HTMLButtonElement>('[data-testid="wizard-open-anyway"]')!.click();
		await vi.waitFor(() => expect(calledWith).toBe('p9'));
		// Let the rejected promise's `.catch` settle before the test ends —
		// this is exactly the window an uncaught rejection would surface in.
		await new Promise((r) => setTimeout(r, 0));
		unmount(c);
	});
});
