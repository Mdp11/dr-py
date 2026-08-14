<script lang="ts">
	import { AlertCircle, AlertTriangle } from '@lucide/svelte';
	import MetamodelStructuralDiff from '../MetamodelStructuralDiff.svelte';
	import type { IssueOut, MetamodelDiff } from '$lib/api/types';

	type Props = { diff: MetamodelDiff };
	let { diff }: Props = $props();

	const CAP = 200;
</script>

<div class="flex flex-col gap-3 text-sm">
	<section class="flex flex-col gap-1">
		<h3 class="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
			Structural changes
		</h3>
		<MetamodelStructuralDiff diff={diff.structural} />
	</section>

	<div class="flex flex-wrap items-center gap-3 text-xs">
		<span class="text-destructive">{diff.now_failing.length} now failing</span>
		<span class="text-success">{diff.now_passing.length} now passing</span>
		<span class="text-muted-foreground">{diff.unchanged_count} unchanged</span>
		<span class="text-muted-foreground/70">
			errors {diff.current_error_count} → {diff.candidate_error_count}
		</span>
	</div>

	{@render section('Now failing', diff.now_failing, 'fail')}
	{@render section('Now passing', diff.now_passing, 'pass')}
</div>

{#snippet section(title: string, issues: IssueOut[], kind: 'fail' | 'pass')}
	{#if issues.length > 0}
		<section class="flex flex-col gap-1">
			<h3
				class="text-[10px] font-semibold uppercase tracking-wider {kind === 'fail'
					? 'text-destructive'
					: 'text-success'}"
			>
				{title} ({issues.length})
			</h3>
			<ul class="flex max-h-48 flex-col gap-1 overflow-auto">
				<!-- Keyed by index: two issues can be byte-identical (same message, same
				     targets), and a duplicate `each` key throws in production too. -->
				{#each issues.slice(0, CAP) as it, i (`${i}:${it.message}`)}
					<li
						class="flex flex-col gap-1 rounded border border-border bg-muted/40 px-2 py-1.5 text-xs"
					>
						<div class="flex items-start gap-1.5">
							{#if it.severity === 'error'}
								<AlertCircle class="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
							{:else}
								<AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
							{/if}
							<span class="flex-1 text-foreground/90">{it.message}</span>
						</div>
						{#if it.target_ids.length > 0}
							<div class="flex flex-wrap gap-1 pl-5">
								{#each it.target_ids as tid, ti (`${ti}:${tid}`)}
									<span
										class="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground/80"
										title={tid}
									>
										{tid}
									</span>
								{/each}
							</div>
						{/if}
					</li>
				{/each}
			</ul>
			{#if issues.length > CAP}
				<p class="text-[10px] text-muted-foreground/70">…and {issues.length - CAP} more</p>
			{/if}
		</section>
	{/if}
{/snippet}
