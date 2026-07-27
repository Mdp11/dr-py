<script lang="ts">
	// The single mounted `ConfirmDialog` behind the app-wide `confirm()` helper.
	// Lives in the root layout so any module can prompt without owning a dialog.
	import { ConfirmDialog } from '$lib/components/ui/confirm-dialog';
	import { answerConfirm, getPendingConfirm } from '$lib/state/confirm.svelte';

	const pending = $derived(getPendingConfirm());
</script>

{#if pending}
	<!-- Keyed on the request id so each prompt mounts a FRESH dialog.
	     ConfirmDialog closes itself by assigning its own `open` prop, so a
	     reused instance would come back already closed and the next queued
	     request would silently render nothing. -->
	{#key pending.id}
		<ConfirmDialog
			open
			title={pending.title}
			description={pending.description}
			confirmLabel={pending.confirmLabel}
			cancelLabel={pending.cancelLabel}
			variant={pending.variant}
			onConfirm={() => answerConfirm(true)}
			onCancel={() => answerConfirm(false)}
		/>
	{/key}
{/if}
