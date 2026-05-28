<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { dropView, getView, getViewWarnings } from '$lib/state';
	import { AlertTriangle, X } from '@lucide/svelte';

	const view = $derived(getView());
	const warnings = $derived(getViewWarnings());

	async function onClear(): Promise<void> {
		if (view === null) return;
		if (!window.confirm(`Clear view "${view.name}"? Folder structure is forgotten until reloaded.`))
			return;
		try {
			await dropView();
		} catch (err) {
			console.error('Failed to clear view', err);
		}
	}
</script>

{#if view !== null}
	<div
		class="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5 text-xs"
		aria-label="Active view"
	>
		<span class="text-[10px] uppercase tracking-wider text-zinc-500">View</span>
		<span class="truncate font-medium text-zinc-200" title={view.name}>{view.name}</span>
		{#if warnings.length > 0}
			<span class="flex items-center gap-0.5 text-amber-400" title="View has warnings">
				<AlertTriangle class="h-3 w-3" />
				<span class="font-mono text-[10px]">{warnings.length}</span>
			</span>
		{/if}
		<Button
			variant="ghost"
			size="sm"
			class="ml-auto h-6 gap-1 px-2 text-[10px] uppercase tracking-wider text-zinc-500 hover:text-zinc-200"
			onclick={onClear}
			aria-label="Clear active view"
			title="Clear active view"
		>
			<X class="h-3 w-3" />
			Clear
		</Button>
	</div>
{/if}
