<script lang="ts">
	import type { Element, Relationship } from '$lib/api/types';
	import { Separator } from '$lib/components/ui/separator';
	import {
		canEdit,
		emit,
		ensureElement,
		getCachedElements,
		getCachedRelationships,
		getMissingElementIds,
		getSelection,
		isTempId,
		lockBadgeFor,
		select
	} from '$lib/state';
	import { confirm } from '$lib/state/confirm.svelte';
	import { deleteLock } from '$lib/state/edit-gate';
	import { elementDisplayName } from '$lib/util/element-name';
	import HistoryNav from './Inspector/HistoryNav.svelte';
	import LockControl from './Inspector/LockControl.svelte';
	import NewRelationshipPicker from './Inspector/NewRelationshipPicker.svelte';
	import PropertyForm from './Inspector/PropertyForm.svelte';
	import RelationshipsList from './Inspector/RelationshipsList.svelte';

	const selection = $derived(getSelection());
	const elements = $derived(getCachedElements());
	const relationships = $derived(getCachedRelationships());

	// cache-or-fetch on selection change
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

	// An uncached element selection is LOADING until the cache-or-fetch settles:
	// only a confirmed miss (404 / deleted — tracked in the missing-ids set) or
	// an uncached temp id (the server never heard of it) is truly "not found".
	const loading = $derived(
		entity === null &&
			selection?.kind === 'element' &&
			!getMissingElementIds().has(selection.id) &&
			!isTempId(selection.id)
	);

	// --- Relationship endpoint navigation -------------------------------------
	// A relationship selection is otherwise a navigational dead end: the
	// Relationships section below is element-only, so without these two buttons
	// a user who lands here from an issue (endpoint typing, multiplicity) has no
	// way back to either endpoint. Pull the endpoints in on demand so they can
	// be labelled by name rather than by raw id.
	$effect(() => {
		if (entity !== null && selection?.kind === 'relationship') {
			const rel = entity as Relationship;
			void ensureElement(rel.source_id);
			void ensureElement(rel.target_id);
		}
	});

	const sourceEl = $derived.by((): Element | null => {
		if (entity === null || selection?.kind !== 'relationship') return null;
		return elements.get((entity as Relationship).source_id) ?? null;
	});

	const targetEl = $derived.by((): Element | null => {
		if (entity === null || selection?.kind !== 'relationship') return null;
		return elements.get((entity as Relationship).target_id) ?? null;
	});

	// The endpoint may not be cached yet (or may have been deleted): fall back to
	// the raw id so the button is always clickable — navigating to a missing
	// element renders the Inspector's own "not found" state, which beats a
	// button that is silently absent.
	function displayName(el: Element | null, fallbackId: string): string {
		return el === null ? fallbackId : elementDisplayName(el);
	}

	function gotoElement(id: string): void {
		select({ kind: 'element', id });
	}

	// --- Delete ---------------------------------------------------------------
	const editable = $derived(canEdit());

	// Deleting locks the element itself; if a peer holds that lock the delete
	// cannot succeed, so disable the button rather than let it fail on click.
	const deleteLockedByOther = $derived(
		selection?.kind === 'element' ? lockBadgeFor(selection.id).state === 'theirs' : false
	);

	const deleteDisabledReason = $derived(
		deleteLockedByOther
			? 'Locked by another user'
			: editable
				? undefined
				: 'You have view-only access'
	);

	async function onDeleteElement(): Promise<void> {
		if (entity === null || selection?.kind !== 'element') return;
		// Pin the id BEFORE awaiting: `entity` is derived from the live selection,
		// and the confirmation is not the blocking browser dialog it used to be —
		// the realtime feed or a keyboard shortcut can move the selection while it
		// is open. Deleting whatever happens to be selected on the way back out is
		// not what the user was asked about.
		const targetId = entity.id;
		const confirmed = await confirm({
			title: 'Delete element',
			description: 'Delete this element? Related relationships will also be removed.',
			confirmLabel: 'Delete',
			variant: 'destructive'
		});
		if (!confirmed) return;
		// The lease is acquired BEFORE the op is staged: an unlockable element
		// (peer lease, viewer role) must not leave a staged delete behind.
		if (!(await deleteLock(targetId))) return;
		emit({ kind: 'delete_element', id: targetId });
		select(null);
	}
</script>

<aside
	data-testid="inspector"
	class="flex h-full flex-col overflow-hidden border-l border-border bg-background text-sm text-foreground/80"
>
	<!-- Outside the state branches on purpose: the back/forward cluster must
	     survive every Inspector state (empty / loading / not-found / entity),
	     otherwise a deselect would unmount the only way back. -->
	<HistoryNav />
	{#if selection === null}
		<section
			class="flex flex-1 flex-col items-center justify-center gap-1 overflow-auto px-3 py-6 text-center"
		>
			<p class="font-display text-base font-light text-muted-foreground">No element selected</p>
			<p class="text-xs text-muted-foreground/70">Select an entity from the tree to inspect it.</p>
		</section>
	{:else if loading}
		<section
			data-testid="inspector-loading"
			class="flex flex-1 flex-col gap-3 overflow-hidden px-3 py-3"
			aria-busy="true"
		>
			<span class="h-3 w-20 animate-pulse rounded bg-muted"></span>
			<span class="h-6 w-40 animate-pulse rounded bg-muted"></span>
			<span class="h-4 w-full animate-pulse rounded bg-muted"></span>
			<span class="h-4 w-3/4 animate-pulse rounded bg-muted"></span>
			<span class="h-4 w-5/6 animate-pulse rounded bg-muted"></span>
		</section>
	{:else if entity === null}
		<section
			class="flex flex-1 flex-col items-center justify-center gap-1 overflow-auto px-3 py-6 text-center"
		>
			<p class="font-display text-base font-light text-muted-foreground">Selection not found</p>
			<p class="text-xs text-muted-foreground/70">This selection no longer exists.</p>
		</section>
	{:else}
		<div class="flex-1 overflow-auto">
			<!-- Stereotype header: "Element/Relationship + type_name", but
			     deliberately NOT a heading element — the Properties section below
			     has its own "Properties" heading, and a second one with the same
			     accessible name would be ambiguous for AT and tests. -->
			<header class="flex flex-col gap-0.5 border-b border-border px-3 py-2">
				<span class="microlabel">{selection.kind === 'element' ? 'Element' : 'Relationship'}</span>
				<p
					data-testid="inspector-stereotype"
					class="font-display text-base font-light tracking-wide text-foreground"
				>
					{entity.type_name}
				</p>
				{#if selection.kind === 'relationship'}
					{@const rel = entity as Relationship}
					<div
						data-testid="relationship-endpoints"
						class="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-foreground/80"
					>
						<button
							type="button"
							data-testid="goto-source"
							class="rounded bg-card px-1.5 py-0.5 font-mono text-[11px] text-foreground/90 transition-colors hover:bg-muted"
							onclick={() => gotoElement(rel.source_id)}
							title={rel.source_id}
						>
							{displayName(sourceEl, rel.source_id)}
						</button>
						<span class="text-muted-foreground/70">→</span>
						<button
							type="button"
							data-testid="goto-target"
							class="rounded bg-card px-1.5 py-0.5 font-mono text-[11px] text-foreground/90 transition-colors hover:bg-muted"
							onclick={() => gotoElement(rel.target_id)}
							title={rel.target_id}
						>
							{displayName(targetEl, rel.target_id)}
						</button>
					</div>
				{/if}
			</header>
			<section class="px-3 py-2">
				<div class="mb-2 flex items-center justify-between gap-2">
					<h2 class="microlabel">Properties</h2>
					{#if selection.kind === 'element'}
						<div class="flex items-center gap-2">
							<LockControl elementId={selection.id} />
							<button
								type="button"
								data-testid="delete-element"
								class="text-xs text-destructive underline-offset-2 hover:underline disabled:cursor-not-allowed disabled:no-underline disabled:opacity-50"
								disabled={deleteDisabledReason !== undefined}
								title={deleteDisabledReason}
								onclick={onDeleteElement}
							>
								Delete
							</button>
						</div>
					{/if}
				</div>
				<PropertyForm {entity} kind={selection.kind} />
			</section>
			{#if selection.kind === 'element'}
				<!-- Pass the id from `selection` (stable across edits), NOT `entity.id`:
				     props are live getters, so binding to `entity.id` would make these
				     children's fetch effects depend on the `entity` derived, whose object
				     identity churns on every optimistic property edit — refetching this
				     element's relationships on every keystroke. `selection.id` only
				     changes on re-selection. -->
				<Separator class="bg-border" />
				<section class="px-3 py-2">
					<h2 class="mb-2 microlabel">Relationships</h2>
					<RelationshipsList elementId={selection.id} />
					<div class="mt-3">
						<NewRelationshipPicker sourceId={selection.id} />
					</div>
				</section>
			{/if}
		</div>
	{/if}
</aside>
