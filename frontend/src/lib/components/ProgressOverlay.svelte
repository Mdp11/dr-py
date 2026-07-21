<script lang="ts">
	import { fade, fly } from 'svelte/transition';
	import { assets } from '$app/paths';
	import { getActiveProgress } from '$lib/state/progress.svelte';
	import { dur, MICRO, PANEL } from '$lib/util/motion';

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

		<!-- The label swaps on the spline ticker; a keyed block crossfades the old
		     line out and the new one in (absolutely stacked so nothing reflows). -->
		<div class="relative h-4 w-[30rem] max-w-[80vw]">
			{#key entry.label}
				<p
					class="microlabel absolute inset-0 text-center"
					in:fly={{ y: 4, duration: dur(PANEL), delay: dur(MICRO) }}
					out:fly={{ y: -4, duration: dur(MICRO) }}
				>
					{entry.label}
				</p>
			{/key}
		</div>

		{#if percent === null}
			<!-- Indeterminate: a generic spinner. A partial bar here would read as
			     stuck progress — there is no percentage to show. -->
			<div
				data-testid="progress-spinner"
				class="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-primary"
			></div>
		{:else}
			<div class="flex flex-col items-center gap-2">
				<div class="h-0.5 w-56 overflow-hidden rounded-full bg-muted">
					<div class="h-full bg-primary transition-[width]" style:width={`${percent}%`}></div>
				</div>
				<span data-testid="progress-percent" class="microlabel tabular-nums">{percent}%</span>
			</div>
		{/if}
	</div>
{/if}
