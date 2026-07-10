<script lang="ts">
	import { canEdit, discardElement, getStagedOpsFor, isCheckedOutByMe } from '$lib/state';
	import { editLock } from '$lib/state';
	import { lockBadgeFor } from '$lib/state';

	// The lock/unlock affordance for the selected element. Three states:
	//   - I hold the lock  -> "Unlock" (release my lease; discards this element's
	//     staged edits, with a confirm when any exist).
	//   - a peer holds it  -> a disabled "Locked by <peer>" badge (I cannot act).
	//   - nobody holds it  -> "Lock" (check the element out WITHOUT editing it,
	//     so the user can claim it before starting work). Disabled for viewers.
	// "mine" is read from the checkout registry (the authoritative source for my
	// own tokens), not the realtime feed, so it is correct without a round-trip.
	let { elementId }: { elementId: string } = $props();

	const lockedByMe = $derived(isCheckedOutByMe(elementId));
	const badge = $derived(lockBadgeFor(elementId));
	const changeCount = $derived(getStagedOpsFor(elementId).length);
	const editable = $derived(canEdit());

	let busy = $state(false);

	async function onLock(): Promise<void> {
		if (busy) return;
		busy = true;
		try {
			// editLock acquires an exclusive lease and surfaces a lock-conflict
			// notice on failure; no staged edit is emitted, so the element is
			// simply checked out.
			await editLock(elementId);
		} finally {
			busy = false;
		}
	}

	async function onUnlock(): Promise<void> {
		if (busy) return;
		if (changeCount > 0) {
			const ok = window.confirm(
				`Unlock this element? ${changeCount} unsaved change${changeCount === 1 ? '' : 's'} ` +
					`to this element will be discarded.`
			);
			if (!ok) return;
		}
		busy = true;
		try {
			// discardElement reverts this element's staged edits (a no-op when there
			// are none) and releases its lease.
			await discardElement(elementId);
		} finally {
			busy = false;
		}
	}
</script>

{#if lockedByMe}
	<button
		type="button"
		data-testid="lock-control"
		class="rounded border border-input px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
		disabled={busy}
		onclick={onUnlock}
	>
		Unlock
	</button>
{:else if badge.state === 'theirs'}
	<span
		data-testid="lock-control"
		class="rounded border border-border px-1.5 py-0.5 text-[10px] text-warning/80"
		title={`Locked by ${badge.holder ?? 'another user'}`}
	>
		Locked by {badge.holder ?? 'another user'}
	</span>
{:else}
	<button
		type="button"
		data-testid="lock-control"
		class="rounded border border-input px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:border-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
		disabled={busy || !editable}
		title={editable ? 'Check out this element without editing' : 'You have view-only access'}
		onclick={onLock}
	>
		Lock
	</button>
{/if}
