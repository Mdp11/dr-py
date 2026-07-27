// The app-level confirmation host: one mounted dialog serving the promise-based
// `confirm()` helper that replaced the repo's `window.confirm` call sites.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ConfirmHost from '../ConfirmHost.svelte';
import { confirm, resetConfirm } from '$lib/state/confirm.svelte';

/** bits-ui defers Content mount/unmount past a requestAnimationFrame, which
 * flushSync() alone does not drive — mirrors TableView.test.ts's helper. */
async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > deadline) throw new Error('waitFor timed out');
		await new Promise((r) => setTimeout(r, 10));
		flushSync();
	}
}

const dialog = (): HTMLElement | null => document.querySelector('[data-testid="confirm-dialog"]');
const confirmBtn = (): HTMLElement =>
	document.querySelector('[data-testid="confirm-dialog-confirm"]') as HTMLElement;
const cancelBtn = (): HTMLElement =>
	document.querySelector('[data-testid="confirm-dialog-cancel"]') as HTMLElement;

const OPTS = { title: 'Delete project', description: 'This cannot be undone.' };

describe('ConfirmHost', () => {
	let component: ReturnType<typeof mount>;

	beforeEach(() => {
		resetConfirm();
		component = mount(ConfirmHost, { target: document.body });
		flushSync();
	});

	afterEach(() => {
		resetConfirm();
		unmount(component);
		document.body.innerHTML = '';
	});

	it('renders nothing until something asks', () => {
		expect(dialog()).toBeNull();
	});

	it('shows the requested title, description and labels', async () => {
		void confirm({ ...OPTS, confirmLabel: 'Delete', cancelLabel: 'Keep', variant: 'destructive' });
		flushSync();
		await waitFor(() => !!dialog());
		expect(dialog()?.textContent).toContain('Delete project');
		expect(dialog()?.textContent).toContain('This cannot be undone.');
		expect(confirmBtn().textContent?.trim()).toBe('Delete');
		expect(cancelBtn().textContent?.trim()).toBe('Keep');
		// `variant` must reach the shared Button — see confirm-dialog.test.ts.
		expect(confirmBtn().className).toContain('text-destructive');
	});

	it('resolves true on confirm and closes', async () => {
		const answer = confirm(OPTS);
		flushSync();
		await waitFor(() => !!dialog());
		confirmBtn().click();
		flushSync();
		expect(await answer).toBe(true);
		await waitFor(() => dialog() === null);
	});

	it('resolves false on cancel and closes', async () => {
		const answer = confirm(OPTS);
		flushSync();
		await waitFor(() => !!dialog());
		cancelBtn().click();
		flushSync();
		expect(await answer).toBe(false);
		await waitFor(() => dialog() === null);
	});

	it('resolves false when dismissed with Escape', async () => {
		const answer = confirm(OPTS);
		flushSync();
		await waitFor(() => !!dialog());
		// `cancelable: true` is load-bearing: bits-ui clones the event via
		// `new KeyboardEvent(e.type, e)`, so a non-cancelable event turns its
		// preventDefault() into a silent no-op and the test would lie.
		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
		flushSync();
		expect(await answer).toBe(false);
	});

	it('queues a second request rather than dropping it, and answers each on its own', async () => {
		const first = confirm({ title: 'First', description: 'one' });
		const second = confirm({ title: 'Second', description: 'two' });
		flushSync();
		await waitFor(() => !!dialog());

		// One at a time — the queued request must not render a second dialog.
		expect(document.querySelectorAll('[data-testid="confirm-dialog"]').length).toBe(1);
		expect(dialog()?.textContent).toContain('First');

		cancelBtn().click();
		flushSync();
		expect(await first).toBe(false);

		// The queued request takes over — a fresh dialog, its own answer.
		await waitFor(() => !!dialog() && !!dialog()?.textContent?.includes('Second'));
		confirmBtn().click();
		flushSync();
		expect(await second).toBe(true);
	});

	it('does not answer the queued request when the one before it is confirmed', async () => {
		// The teardown risk: answering advances the queue, which destroys the open
		// dialog mid-flight. If that teardown re-emitted a dismissal, it would
		// land on the NEXT request and silently decline something nobody saw.
		const first = confirm({ title: 'First', description: 'one' });
		const second = confirm({ title: 'Second', description: 'two' });
		flushSync();
		await waitFor(() => !!dialog());

		confirmBtn().click();
		flushSync();
		expect(await first).toBe(true);

		// The second request is still standing, unanswered.
		await waitFor(() => !!dialog()?.textContent?.includes('Second'));
		let settled = false;
		void second.then(() => {
			settled = true;
		});
		await new Promise((r) => setTimeout(r, 20));
		flushSync();
		expect(settled).toBe(false);

		confirmBtn().click();
		flushSync();
		expect(await second).toBe(true);
	});

	it('settles every outstanding request as declined on reset', async () => {
		const first = confirm({ title: 'First', description: 'one' });
		const second = confirm({ title: 'Second', description: 'two' });
		flushSync();
		resetConfirm();
		flushSync();
		expect(await first).toBe(false);
		expect(await second).toBe(false);
		await waitFor(() => dialog() === null);
	});
});
