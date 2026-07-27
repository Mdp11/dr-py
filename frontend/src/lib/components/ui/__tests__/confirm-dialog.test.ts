// A small reusable confirmation dialog. Built for the table settings dialog's
// discard gate; kept generic so future call sites need not re-invent it.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ConfirmDialog from '../confirm-dialog/confirm-dialog.svelte';

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

function render(props: Record<string, unknown>) {
	const c = mount(ConfirmDialog, {
		target: document.body,
		props: {
			open: true,
			title: 'Discard changes?',
			description: 'Your unsaved column changes will be lost.',
			onConfirm: () => {},
			...props
		}
	});
	flushSync();
	return c;
}

afterEach(() => {
	document.body.innerHTML = '';
	vi.restoreAllMocks();
});

describe('ConfirmDialog', () => {
	it('renders its title and description when open', async () => {
		const c = render({});
		try {
			await waitFor(() => !!document.querySelector('[data-testid="confirm-dialog"]'));
			const dlg = document.querySelector('[data-testid="confirm-dialog"]');
			expect(dlg?.textContent).toContain('Discard changes?');
			expect(dlg?.textContent).toContain('Your unsaved column changes will be lost.');
		} finally {
			unmount(c);
		}
	});

	it('renders nothing when closed', () => {
		const c = render({ open: false });
		try {
			expect(document.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
		} finally {
			unmount(c);
		}
	});

	it('fires onConfirm on the confirm button', async () => {
		const onConfirm = vi.fn();
		const c = render({ onConfirm });
		try {
			await waitFor(() => !!document.querySelector('[data-testid="confirm-dialog-confirm"]'));
			(document.querySelector('[data-testid="confirm-dialog-confirm"]') as HTMLElement).click();
			flushSync();
			expect(onConfirm).toHaveBeenCalledTimes(1);
		} finally {
			unmount(c);
		}
	});

	it('fires onCancel on the cancel button, not onConfirm', async () => {
		const onConfirm = vi.fn();
		const onCancel = vi.fn();
		const c = render({ onConfirm, onCancel });
		try {
			await waitFor(() => !!document.querySelector('[data-testid="confirm-dialog-cancel"]'));
			(document.querySelector('[data-testid="confirm-dialog-cancel"]') as HTMLElement).click();
			flushSync();
			expect(onCancel).toHaveBeenCalledTimes(1);
			expect(onConfirm).not.toHaveBeenCalled();
		} finally {
			unmount(c);
		}
	});

	it('uses the supplied labels and marks the destructive variant', async () => {
		const destructive = render({
			confirmLabel: 'Discard changes',
			cancelLabel: 'Keep editing',
			variant: 'destructive'
		});
		let defaultRender: ReturnType<typeof render> | undefined;
		try {
			await waitFor(() => !!document.querySelector('[data-testid="confirm-dialog-confirm"]'));
			const confirm = document.querySelector('[data-testid="confirm-dialog-confirm"]');
			const cancel = document.querySelector('[data-testid="confirm-dialog-cancel"]');
			expect(confirm?.textContent?.trim()).toBe('Discard changes');
			expect(cancel?.textContent?.trim()).toBe('Keep editing');

			const destructiveClass = confirm?.className ?? '';
			unmount(destructive);
			document.body.innerHTML = '';

			// Render again with the default variant and diff the class lists —
			// a hollow check like `.toContain('rounded')` would still pass if
			// `variant` were silently ignored. Pinning `text-destructive`'s
			// presence/absence (the Button component's own destructive-variant
			// token, per button.svelte's `tv()` config) actually fails if the
			// variant prop stops being threaded through.
			defaultRender = render({});
			await waitFor(() => !!document.querySelector('[data-testid="confirm-dialog-confirm"]'));
			const defaultClass =
				document.querySelector('[data-testid="confirm-dialog-confirm"]')?.className ?? '';

			expect(destructiveClass).not.toBe(defaultClass);
			expect(destructiveClass).toContain('text-destructive');
			expect(defaultClass).not.toContain('text-destructive');
		} finally {
			if (defaultRender) unmount(defaultRender);
		}
	});
});
