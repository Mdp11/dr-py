<script lang="ts">
	import { fade } from 'svelte/transition';
	import { assets } from '$app/paths';
	import { getActiveProgress } from '$lib/state/progress.svelte';
	import { dur, PANEL } from '$lib/util/motion';

	const entry = $derived(getActiveProgress());
	const percent = $derived.by(() => {
		if (!entry || entry.total === null || entry.total <= 0) return null;
		return Math.min(100, Math.round(((entry.done ?? 0) / entry.total) * 100));
	});
</script>

{#if entry}
	<div
		class="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-4 bg-background/90 backdrop-blur-sm"
		role="status"
		aria-live="polite"
		data-testid="progress-overlay"
		transition:fade={{ duration: dur(PANEL) }}
	>
		<img src={`${assets}/dr-mark.png`} alt="" class="h-8 w-auto opacity-90" />

		<p class="microlabel">
			{entry.label}{#if percent !== null}
				&nbsp;<span data-testid="progress-percent">{percent}%</span>
			{/if}
		</p>

		{#if percent === null}
			<!-- Indeterminate: a generic spinner. A partial bar here would read as
			     stuck progress — there is no percentage to show. -->
			<div
				data-testid="progress-spinner"
				class="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-primary"
			></div>
		{:else}
			<div class="h-0.5 w-56 overflow-hidden rounded-full bg-muted">
				<div class="h-full bg-primary transition-[width]" style:width={`${percent}%`}></div>
			</div>
		{/if}
	</div>
{/if}
