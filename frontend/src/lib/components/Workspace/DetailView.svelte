<script lang="ts">
	import type { Element, Relationship } from '$lib/api/types';
	import {
		emit,
		ensureElement,
		getCachedElements,
		getCachedRelationships,
		getSelection,
		select
	} from '$lib/state';
	import { deleteLock } from '$lib/state/edit-gate';
	import { lockBadgeFor } from '$lib/state';
	import { nameProp } from '$lib/util/element-name';
	import PropertyForm from '../Inspector/PropertyForm.svelte';

	const selection = $derived(getSelection());
	const elements = $derived(getCachedElements());
	const relationships = $derived(getCachedRelationships());

	// cache-or-fetch: selecting an uncached element (deep link, issue target)
	// pulls it in on demand; the cached maps are reactive so the entity pops
	// in as soon as the fetch lands or a delta upserts it.
	$effect(() => {
		if (selection?.kind === 'element') void ensureElement(selection.id);
	});

	const entity = $derived.by((): Element | Relationship | null => {
		if (selection === null) return null;
		if (selection.kind === 'element') {
			return elements.get(selection.id) ?? null;
		}
		return relationships.get(selection.id) ?? null;
	});

	$effect(() => {
		if (entity !== null && selection?.kind === 'relationship') {
			const rel = entity as Relationship;
			void ensureElement(rel.source_id);
			void ensureElement(rel.target_id);
		}
	});

	const sourceEl = $derived.by((): Element | null => {
		if (entity === null || selection?.kind !== 'relationship') return null;
		const rel = entity as Relationship;
		return elements.get(rel.source_id) ?? null;
	});

	const targetEl = $derived.by((): Element | null => {
		if (entity === null || selection?.kind !== 'relationship') return null;
		const rel = entity as Relationship;
		return elements.get(rel.target_id) ?? null;
	});

	// The delete/disconnect action locks the element itself (delete) or the
	// relationship's SOURCE element (disconnect); if a peer holds that lock the
	// action can't succeed, so disable the button instead of failing on click.
	const deleteLockedByOther = $derived.by((): boolean => {
		if (entity === null) return false;
		const lockId =
			selection?.kind === 'relationship' ? (entity as Relationship).source_id : entity.id;
		return lockBadgeFor(lockId).state === 'theirs';
	});

	function displayName(el: Element | null, fallbackId: string): string {
		if (el === null) return fallbackId;
		return nameProp(el.properties) ?? el.id;
	}

	async function onDeleteElement(): Promise<void> {
		if (entity === null || selection?.kind !== 'element') return;
		const confirmed = window.confirm(
			'Delete this element? Related relationships will also be removed.'
		);
		if (!confirmed) return;
		if (!(await deleteLock(entity.id))) return;
		emit({ kind: 'delete_element', id: entity.id });
		select(null);
	}

	async function onDisconnectRelationship(): Promise<void> {
		if (entity === null || selection?.kind !== 'relationship') return;
		// a relationship is locked via its SOURCE element (backend rule)
		const rel = entity as Relationship;
		if (!(await deleteLock(rel.source_id))) return;
		emit({ kind: 'delete_relationship', id: entity.id });
		select(null);
	}

	function gotoElement(id: string): void {
		select({ kind: 'element', id });
	}
</script>

{#if selection === null}
	<div class="flex h-full flex-col items-center justify-center gap-1 px-4 text-center">
		<p class="font-display text-base font-light text-muted-foreground">No element selected</p>
		<p class="text-xs text-muted-foreground/70">Select an entity from the tree or use search.</p>
	</div>
{:else if entity === null}
	<div class="flex h-full flex-col items-center justify-center gap-1 px-4 text-center">
		<p class="font-display text-base font-light text-muted-foreground">Selection not found</p>
		<p class="text-xs text-muted-foreground/70">This selection no longer exists.</p>
	</div>
{:else if selection.kind === 'element'}
	<div class="flex flex-col gap-3 p-4">
		<header class="flex items-baseline justify-between gap-2 border-b border-border pb-2">
			<div class="flex flex-col gap-0.5">
				<span class="microlabel">Element</span>
				<h2 class="font-display text-base font-light tracking-wide text-foreground">
					{entity.type_name}
				</h2>
			</div>
			<button
				type="button"
				class="text-xs text-destructive underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50 disabled:no-underline"
				disabled={deleteLockedByOther}
				title={deleteLockedByOther ? 'Locked by another user' : undefined}
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
		<header class="flex flex-col gap-2 border-b border-border pb-2">
			<div class="flex items-baseline justify-between gap-2">
				<div class="flex flex-col gap-0.5">
					<span class="microlabel">Relationship</span>
					<h2 class="font-display text-base font-light tracking-wide text-foreground">
						{rel.type_name}
					</h2>
				</div>
				<button
					type="button"
					class="text-xs text-destructive underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:opacity-50 disabled:no-underline"
					disabled={deleteLockedByOther}
					title={deleteLockedByOther ? 'Locked by another user' : undefined}
					onclick={onDisconnectRelationship}
				>
					Disconnect
				</button>
			</div>
			<div class="flex items-center gap-2 text-xs text-foreground/80">
				<button
					type="button"
					class="rounded bg-card px-1.5 py-0.5 font-mono text-[11px] text-foreground/90 hover:bg-muted"
					onclick={() => gotoElement(rel.source_id)}
					title={rel.source_id}
				>
					{displayName(sourceEl, rel.source_id)}
				</button>
				<span class="text-muted-foreground/70">→</span>
				<button
					type="button"
					class="rounded bg-card px-1.5 py-0.5 font-mono text-[11px] text-foreground/90 hover:bg-muted"
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
