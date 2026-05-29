<script lang="ts">
	import type { ModelOut } from '$lib/api/types';
	import { getBaseline, getFilename } from '$lib/state';
	import { computeDiff } from '$lib/state/diff';
	import { comparePair } from '$lib/state/compare';
	import { buildChangeRequest, composeCrFilename } from '$lib/state/cr';
	import { saveJsonToFile } from '$lib/util/fileSave';
	import { Button } from '$lib/components/ui/button';
	import CompareDiff from '$lib/components/CompareDiff.svelte';

	const loaded = $derived(getBaseline());
	const loadedFilename = $derived(getFilename());

	let other: ModelOut | null = $state(null);
	let otherFilename: string | null = $state(null);
	let swapped = $state(false);
	let fileInputRef: HTMLInputElement | null = $state(null);
	let errorMessage: string | null = $state(null);

	const pair = $derived(
		loaded && other ? comparePair(loaded, loadedFilename, other, otherFilename, swapped) : null
	);
	const diff = $derived(pair ? computeDiff(pair.from, pair.to) : null);
	const totalEntities = $derived(pair ? pair.to.elements.length + pair.to.relationships.length : 0);
	const unchangedHidden = $derived(
		diff ? Math.max(0, totalEntities - (diff.counts.added + diff.counts.modified)) : 0
	);

	async function onFileSelected(event: Event): Promise<void> {
		const target = event.target as HTMLInputElement;
		const file = target.files?.[0];
		target.value = '';
		if (!file) return;
		try {
			const parsed = JSON.parse(await file.text());
			other = { elements: parsed.elements ?? [], relationships: parsed.relationships ?? [] };
			otherFilename = file.name;
			errorMessage = null;
		} catch (err) {
			other = null;
			errorMessage = err instanceof Error ? err.message : 'Invalid JSON';
		}
	}

	async function onExportCr(): Promise<void> {
		if (!pair) return;
		try {
			const cr = buildChangeRequest(pair.from, pair.to, pair.fromFilename);
			await saveJsonToFile(cr, composeCrFilename(pair.fromFilename));
		} catch (err) {
			if (err instanceof DOMException && err.name === 'AbortError') return;
			errorMessage = err instanceof Error ? err.message : 'Export failed';
		}
	}
</script>

<div class="mx-auto flex max-w-4xl flex-col gap-4 p-6">
	<div class="flex items-center gap-2">
		<a href="/" class="text-sm text-zinc-400 hover:text-zinc-200">← Back</a>
		<h1 class="text-lg font-semibold">Compare models</h1>
	</div>

	{#if !loaded}
		<p class="text-sm text-zinc-400">
			Load a model first (from the main workspace), then return here to compare.
		</p>
	{:else}
		<div class="flex flex-wrap items-center gap-2 text-sm">
			<span class="text-zinc-500">Loaded:</span>
			<span class="font-mono text-xs text-zinc-300">{loadedFilename ?? 'model'}</span>
			<Button type="button" variant="outline" size="sm" onclick={() => fileInputRef?.click()}>
				Choose other model…
			</Button>
			<span class="font-mono text-xs text-zinc-400">{otherFilename ?? 'No file selected'}</span>
			<input
				bind:this={fileInputRef}
				type="file"
				accept=".json"
				class="hidden"
				onchange={onFileSelected}
			/>
			{#if other}
				<Button
					type="button"
					variant="ghost"
					size="sm"
					class="h-7 text-xs"
					onclick={() => (swapped = !swapped)}
				>
					⇄ Swap
				</Button>
			{/if}
		</div>

		{#if errorMessage}
			<p class="text-xs text-red-400">{errorMessage}</p>
		{/if}

		{#if pair && diff}
			<div class="flex items-center gap-2 text-xs text-zinc-400">
				<span>
					From: <span class="font-mono text-zinc-300"
						>{swapped ? (otherFilename ?? 'other') : (loadedFilename ?? 'model')}</span
					>
				</span>
				<span>→</span>
				<span>
					To: <span class="font-mono text-zinc-300"
						>{swapped ? (loadedFilename ?? 'model') : (otherFilename ?? 'other')}</span
					>
				</span>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					class="ml-auto h-7 text-xs"
					onclick={onExportCr}
				>
					Export CR
				</Button>
			</div>
			<CompareDiff {diff} {unchangedHidden} />
		{/if}
	{/if}
</div>
