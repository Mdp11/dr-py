<script lang="ts">
	import type { CrConflictReport, CrPreview } from '$lib/state/cr';
	import CompareDiff from './CompareDiff.svelte';

	type Props = {
		preview: CrPreview | null;
		conflicts: CrConflictReport | null;
		error: string | null;
	};
	let { preview, conflicts, error }: Props = $props();
</script>

{#if error}
	<p class="text-xs text-destructive" data-testid="proposal-error" role="alert">{error}</p>
{/if}

{#if conflicts}
	<div
		class="flex flex-col gap-1 rounded border border-destructive/40 bg-destructive/15 px-3 py-2 text-xs text-destructive"
		role="alert"
		data-testid="proposal-conflicts"
	>
		<p class="font-semibold">
			{conflicts.crIndex === null ? 'Conflicts' : `CR #${conflicts.crIndex + 1} conflicts`} — nothing
			staged
		</p>
		{#each conflicts.items as c (c.entity + c.id + c.kind)}
			<p class="font-mono">{c.entity} {c.id}: {c.kind} — {c.reason}</p>
		{/each}
	</div>
{/if}

{#if preview}
	<div data-testid="proposal-preview">
		<CompareDiff diff={preview.diff} unchangedHidden={preview.unchangedHidden} />
	</div>
{/if}
