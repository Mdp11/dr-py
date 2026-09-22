<script lang="ts">
	import { fade } from 'svelte/transition';
	import { dur, PANEL } from '$lib/util/motion';
	import { Button } from '$lib/components/ui/button';
	import { isReplicaRetrying, retryReplica } from '$lib/state';

	let retryButton = $state<HTMLButtonElement | null>(null);
	const retrying = $derived(isReplicaRetrying());
	// Focus follows the button back whenever it re-enables: on mount, and
	// again if a retry lands back on `failed`.
	$effect(() => {
		if (!retrying) retryButton?.focus();
	});
</script>

<div
	class="fixed inset-0 z-[55] flex flex-col items-center justify-center gap-4 bg-background/90 backdrop-blur-sm"
	role="alertdialog"
	aria-modal="true"
	aria-labelledby="replica-blocked-label"
	data-testid="replica-blocked"
	transition:fade={{ duration: dur(PANEL) }}
>
	<div
		class="flex max-w-sm flex-col items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 px-6 py-5 text-center"
	>
		<span
			id="replica-blocked-label"
			class="text-sm font-semibold uppercase tracking-wide text-warning"
		>
			Model out of sync
		</span>
		<p class="text-xs text-muted-foreground">
			The local copy of the model could not be rebuilt from the server. Your uncommitted edits are
			kept.
		</p>
		<Button bind:ref={retryButton} disabled={retrying} onclick={() => retryReplica()}>
			{retrying ? 'Retrying…' : 'Retry'}
		</Button>
	</div>
</div>
