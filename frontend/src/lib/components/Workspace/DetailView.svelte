<script lang="ts">
	import type { Element, Relationship } from '$lib/api/types';
	import { emit, getSelection, getWorkingModel, select } from '$lib/state';
	import PropertyForm from '../Inspector/PropertyForm.svelte';

	const selection = $derived(getSelection());
	const working = $derived(getWorkingModel());

	const entity = $derived.by((): Element | Relationship | null => {
		if (selection === null) return null;
		if (selection.kind === 'element') {
			return working.elements.find((e) => e.id === selection.id) ?? null;
		}
		return working.relationships.find((r) => r.id === selection.id) ?? null;
	});

	const sourceEl = $derived.by((): Element | null => {
		if (entity === null || selection?.kind !== 'relationship') return null;
		const rel = entity as Relationship;
		return working.elements.find((e) => e.id === rel.source_id) ?? null;
	});

	const targetEl = $derived.by((): Element | null => {
		if (entity === null || selection?.kind !== 'relationship') return null;
		const rel = entity as Relationship;
		return working.elements.find((e) => e.id === rel.target_id) ?? null;
	});

	function displayName(el: Element | null, fallbackId: string): string {
		if (el === null) return fallbackId;
		const n = el.properties?.name;
		return typeof n === 'string' && n.length > 0 ? n : el.id;
	}

	function onDeleteElement(): void {
		if (entity === null || selection?.kind !== 'element') return;
		const confirmed = window.confirm(
			'Delete this element? Related relationships will also be removed.'
		);
		if (!confirmed) return;
		emit({ kind: 'delete_element', id: entity.id });
		select(null);
	}

	function onDisconnectRelationship(): void {
		if (entity === null || selection?.kind !== 'relationship') return;
		emit({ kind: 'delete_relationship', id: entity.id });
		select(null);
	}

	function gotoElement(id: string): void {
		select({ kind: 'element', id });
	}
</script>

{#if selection === null}
	<div class="flex h-full items-center justify-center px-4 text-xs text-zinc-500">
		Select an entity from the tree or use search…
	</div>
{:else if entity === null}
	<div class="flex h-full items-center justify-center px-4 text-xs text-zinc-500">
		Selection no longer exists.
	</div>
{:else if selection.kind === 'element'}
	<div class="flex flex-col gap-3 p-4">
		<header class="flex items-baseline justify-between gap-2 border-b border-zinc-800 pb-2">
			<div class="flex flex-col gap-0.5">
				<span class="text-xs uppercase tracking-wide text-zinc-500">Element</span>
				<h2 class="font-mono text-sm text-zinc-100">{entity.type_name}</h2>
			</div>
			<button
				type="button"
				class="text-xs text-red-400 underline-offset-2 hover:underline"
				onclick={onDeleteElement}
			>
				Delete
			</button>
		</header>
		<PropertyForm entity={entity as Element} kind="element" />
	</div>
{:else}
	{@const rel = entity as Relationship}
	<div class="flex flex-col gap-3 p-4">
		<header class="flex flex-col gap-2 border-b border-zinc-800 pb-2">
			<div class="flex items-baseline justify-between gap-2">
				<div class="flex flex-col gap-0.5">
					<span class="text-xs uppercase tracking-wide text-zinc-500">Relationship</span>
					<h2 class="font-mono text-sm text-zinc-100">{rel.type_name}</h2>
				</div>
				<button
					type="button"
					class="text-xs text-red-400 underline-offset-2 hover:underline"
					onclick={onDisconnectRelationship}
				>
					Disconnect
				</button>
			</div>
			<div class="flex items-center gap-2 text-xs text-zinc-300">
				<button
					type="button"
					class="rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-[11px] text-zinc-200 hover:bg-zinc-800"
					onclick={() => gotoElement(rel.source_id)}
					title={rel.source_id}
				>
					{displayName(sourceEl, rel.source_id)}
				</button>
				<span class="text-zinc-500">→</span>
				<button
					type="button"
					class="rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-[11px] text-zinc-200 hover:bg-zinc-800"
					onclick={() => gotoElement(rel.target_id)}
					title={rel.target_id}
				>
					{displayName(targetEl, rel.target_id)}
				</button>
			</div>
		</header>
		<PropertyForm entity={rel} kind="relationship" />
	</div>
{/if}
