<script lang="ts">
	import { getActiveProgress } from '$lib/state/progress.svelte';

	const entry = $derived(getActiveProgress());
	const percent = $derived.by(() => {
		if (!entry || entry.total === null || entry.total <= 0) return null;
		return Math.min(100, Math.round(((entry.done ?? 0) / entry.total) * 100));
	});

	const R = 26;
	const CIRC = 2 * Math.PI * R;
</script>

{#if entry}
	<div
		class="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-3 bg-black/40 supports-backdrop-filter:backdrop-blur-xs"
		role="status"
		aria-live="polite"
		data-testid="progress-overlay"
	>
		<div class="relative h-20 w-20">
			<svg
				viewBox="0 0 64 64"
				class="h-20 w-20 -rotate-90 {percent === null ? 'animate-spin' : ''}"
			>
				<circle cx="32" cy="32" r={R} fill="none" stroke-width="6" class="stroke-zinc-800" />
				<circle
					cx="32"
					cy="32"
					r={R}
					fill="none"
					stroke-width="6"
					stroke-linecap="round"
					class="stroke-zinc-100"
					stroke-dasharray={percent === null
						? `${CIRC * 0.25} ${CIRC}`
						: `${(CIRC * percent) / 100} ${CIRC}`}
				/>
			</svg>
			{#if percent !== null}
				<span
					class="absolute inset-0 flex items-center justify-center text-sm font-semibold text-zinc-100"
					data-testid="progress-percent">{percent}%</span
				>
			{/if}
		</div>
		<p class="text-xs text-zinc-300">{entry.label}</p>
	</div>
{/if}
