<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { diffMetamodel } from '$lib/api/metamodel';
	import type { MetamodelDiff, IssueOut } from '$lib/api/types';
	import { AlertCircle, AlertTriangle } from '@lucide/svelte';

	type Props = { open: boolean };
	let { open = $bindable(false) }: Props = $props();

	const CAP = 200;

	type Step = 'pick' | 'diffing' | 'review' | 'error';
	let step = $state<Step>('pick');
	let errorMsg = $state<string | null>(null);
	let diff = $state<MetamodelDiff | null>(null);

	function reset(): void {
		step = 'pick';
		errorMsg = null;
		diff = null;
	}

	async function onPick(ev: Event): Promise<void> {
		const input = ev.currentTarget as HTMLInputElement;
		const f = input.files?.[0];
		if (!f) return;
		step = 'diffing';
		errorMsg = null;
		try {
			const text = await f.text();
			diff = await diffMetamodel(text);
			step = 'review';
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			errorMsg = `Couldn't read the candidate or run the diff: ${msg}`;
			step = 'error';
		}
	}
</script>

<Dialog.Root bind:open onOpenChange={(o) => { if (!o) reset(); }}>
	<Dialog.Content class="max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>Swap metamodel</Dialog.Title>
		</Dialog.Header>

		<div class="flex flex-col gap-3 text-sm">
			<label class="flex flex-col gap-1">
				<span class="text-xs text-zinc-400">Candidate metamodel</span>
				<input
					id="swap-metamodel-file"
					type="file"
					accept=".yaml,.yml,.json"
					class="text-xs"
					onchange={onPick}
				/>
			</label>

			{#if step === 'diffing'}
				<p class="text-zinc-400">Running diff…</p>
			{/if}

			{#if step === 'error' && errorMsg}
				<p class="rounded border border-red-900 bg-red-950/40 px-2 py-1.5 text-red-200">
					{errorMsg}
				</p>
			{/if}

			{#if step === 'review' && diff}
				<div class="flex flex-wrap items-center gap-3 text-xs">
					<span class="text-red-300">{diff.now_failing.length} now failing</span>
					<span class="text-emerald-300">{diff.now_passing.length} now passing</span>
					<span class="text-zinc-400">{diff.unchanged_count} unchanged</span>
					<span class="text-zinc-500">
						errors {diff.current_error_count} → {diff.candidate_error_count}
					</span>
				</div>

				{@render section('Now failing', diff.now_failing, 'fail')}
				{@render section('Now passing', diff.now_passing, 'pass')}

				<!-- REBIND-SLOT: Task 4 inserts the rebind affordance here. -->
			{/if}
		</div>

		<Dialog.Footer>
			<Button variant="ghost" size="sm" onclick={() => (open = false)}>Close</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

{#snippet section(title: string, issues: IssueOut[], kind: 'fail' | 'pass')}
	{#if issues.length > 0}
		<section class="flex flex-col gap-1">
			<h3 class="text-[10px] font-semibold uppercase tracking-wider {kind === 'fail' ? 'text-red-300' : 'text-emerald-300'}">
				{title} ({issues.length})
			</h3>
			<ul class="flex max-h-48 flex-col gap-1 overflow-auto">
				{#each issues.slice(0, CAP) as it (it.message + it.target_ids.join(','))}
					<li class="flex flex-col gap-1 rounded border border-zinc-800 bg-zinc-900/40 px-2 py-1.5 text-xs">
						<div class="flex items-start gap-1.5">
							{#if it.severity === 'error'}
								<AlertCircle class="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
							{:else}
								<AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
							{/if}
							<span class="flex-1 text-zinc-200">{it.message}</span>
						</div>
						{#if it.target_ids.length > 0}
							<div class="flex flex-wrap gap-1 pl-5">
								{#each it.target_ids as tid (tid)}
									<span class="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300" title={tid}>
										{tid}
									</span>
								{/each}
							</div>
						{/if}
					</li>
				{/each}
			</ul>
			{#if issues.length > CAP}
				<p class="text-[10px] text-zinc-500">…and {issues.length - CAP} more</p>
			{/if}
		</section>
	{/if}
{/snippet}
