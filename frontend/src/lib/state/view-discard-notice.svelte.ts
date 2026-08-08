/**
 * View-discard notice store (artefacts revamp Phase 2 follow-up, Task 2).
 *
 * `refreshView()`'s conflict path (`view.svelte.ts`'s `dropConflictedJournal`)
 * wipes the WHOLE staged view-op journal when a peer's change makes a
 * replayed op throw — a destructive event the user did not ask for and may
 * not be looking at the screen for. This tiny store carries that message
 * durably: set on conflict, read-and-rendered by the project page as a
 * dismissable banner (alongside the model-error / peer-rebind / feed-
 * termination ones — see `+page.svelte`), cleared only by an explicit
 * dismiss.
 *
 * Deliberately its OWN leaf module rather than a branch of the shared
 * `lock-notice.svelte.ts` channel it replaces: that channel is TRANSIENT by
 * design (`edit-gate.ts`'s `noticed()` clears it on the very next successful
 * lease acquisition of any kind), which is right for "someone else is
 * editing this, try again" but wrong for a destructive discard the user must
 * consciously acknowledge. A plain accessor store (Svelte 5 runes), same
 * shape as `access-notice.svelte.ts`. It imports nothing, so wiring it into
 * `view.svelte.ts` cannot widen that module's `view -> realtime -> artifacts
 * -> view` import cycle (see the long comment at the bottom of
 * `view.svelte.ts`).
 */

let _notice = $state<string | null>(null);

export function getViewDiscardNotice(): string | null {
	return _notice;
}

export function setViewDiscardNotice(message: string): void {
	_notice = message;
}

export function clearViewDiscardNotice(): void {
	_notice = null;
}
