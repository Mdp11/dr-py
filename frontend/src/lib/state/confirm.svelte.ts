/**
 * The app's confirmation prompt — a promise-returning `confirm()` backed by a
 * single `ConfirmHost` mounted in the root layout.
 *
 * This exists to replace `window.confirm`, whose call sites all read
 * `if (!window.confirm(msg)) return;`. A callback-shaped dialog would have
 * forced every one of them to be turned inside out (a `$state` flag, a pending
 * action, a mounted component in that file's markup); a promise keeps the guard
 * where it already reads correctly — `if (!(await confirm({...}))) return;`.
 *
 * The promise is also why one call site did NOT convert: the `beforeNavigate`
 * unload guard in `routes/p/[projectId]/+page.svelte` must call `nav.cancel()`
 * synchronously, so it keeps the browser dialog. It is the only one.
 *
 * Requests QUEUE rather than replace. A second `confirm()` arriving while one
 * is open is vanishingly rare (the dialog is modal), but the alternative —
 * auto-declining the open one to make room — would answer a question the user
 * was in the middle of reading. Nothing here ever settles a request on the
 * user's behalf except `resetConfirm`, which declines.
 */

export interface ConfirmOptions {
	title: string;
	description: string;
	confirmLabel?: string;
	cancelLabel?: string;
	variant?: 'default' | 'destructive';
}

/** The head request, as the host renders it. `id` is what keys the dialog
 * instance, so each request gets a FRESH one — `ConfirmDialog` sets its own
 * `open` to false on the way out, and a reused instance would stay closed. */
export interface PendingConfirm extends ConfirmOptions {
	id: number;
}

interface Request {
	id: number;
	options: ConfirmOptions;
	settle: (confirmed: boolean) => void;
}

/** `$state.raw`, not `$state`: the queue holds resolver functions, and it is
 * always replaced wholesale rather than mutated in place. */
let queue = $state.raw<Request[]>([]);
let nextId = 1;

/** Ask the user to confirm an action. Resolves true only on the confirm
 * button; cancel, Escape and an overlay click all resolve false. */
export function confirm(options: ConfirmOptions): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		queue = [...queue, { id: nextId++, options, settle: resolve }];
	});
}

/** The request the host should be showing, or null when nothing is pending. */
export function getPendingConfirm(): PendingConfirm | null {
	const head = queue[0];
	return head ? { id: head.id, ...head.options } : null;
}

/** Answer the head request and advance the queue. Safe to call when nothing is
 * pending — the host's dialog can emit a dismissal as it tears down. */
export function answerConfirm(confirmed: boolean): void {
	const head = queue[0];
	if (head === undefined) return;
	queue = queue.slice(1);
	head.settle(confirmed);
}

/** Drop every pending request, declining each. For tests; production code has
 * no reason to answer on the user's behalf. */
export function resetConfirm(): void {
	const dropped = queue;
	queue = [];
	for (const req of dropped) req.settle(false);
}
