<script lang="ts">
	import { ChevronDown, ChevronRight, Plus, Route } from '@lucide/svelte';
	import {
		canEdit,
		getArtifactHeaders,
		openNavigationTab,
		removeArtifact,
		renameArtifact
	} from '$lib/state';
	// beginDrag/DragPayload live in tree-drag.svelte.ts, which is not re-exported
	// from `$lib/state` — Search.svelte and ContainmentTree.svelte import it the
	// same way (direct module path), so this mirrors the existing convention.
	import { beginDrag } from '$lib/state/tree-drag.svelte';

	let collapsed = $state(false);
	const navigations = $derived(getArtifactHeaders().filter((a) => a.kind === 'navigation'));
	const editable = $derived(canEdit());

	function openNew(): void {
		openNavigationTab({ artifactId: null, title: 'New navigation' });
	}
	function openExisting(id: string, name: string): void {
		openNavigationTab({ artifactId: id, title: name });
	}
	async function rename(id: string, current: string): Promise<void> {
		const name = window.prompt('Rename navigation', current);
		if (name && name !== current) await renameArtifact(id, name);
	}
	async function del(id: string, name: string): Promise<void> {
		if (window.confirm(`Delete navigation "${name}"?`)) await removeArtifact(id);
	}
	const DRAG_THRESHOLD_PX = 4;
	function onPointerDown(e: PointerEvent, id: string): void {
		if (e.button !== 0 || !e.isPrimary) return;
		const sx = e.clientX;
		const sy = e.clientY;
		let started = false;
		const move = (ev: PointerEvent): void => {
			if (started) return;
			if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_THRESHOLD_PX) return;
			started = true;
			beginDrag({ kind: 'artifact', id, artifactKind: 'navigation' }, true);
			cleanup();
		};
		const up = (): void => cleanup();
		function cleanup(): void {
			window.removeEventListener('pointermove', move);
			window.removeEventListener('pointerup', up);
			window.removeEventListener('pointercancel', up);
		}
		window.addEventListener('pointermove', move);
		window.addEventListener('pointerup', up);
		window.addEventListener('pointercancel', up);
	}
</script>

<section class="border-b border-zinc-800 px-2 py-1.5">
	<div class="flex items-center justify-between">
		<button
			type="button"
			class="flex items-center gap-1 text-xs font-medium text-zinc-400 hover:text-zinc-200"
			onclick={() => (collapsed = !collapsed)}
		>
			{#if collapsed}<ChevronRight class="size-3" />{:else}<ChevronDown class="size-3" />{/if}
			Navigations
			<span class="text-zinc-600">({navigations.length})</span>
		</button>
		{#if editable}
			<button
				type="button"
				aria-label="New navigation"
				class="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
				onclick={openNew}
			>
				<Plus class="size-3.5" />
			</button>
		{/if}
	</div>
	{#if !collapsed}
		<ul class="mt-1 space-y-0.5">
			{#each navigations as nav (nav.id)}
				<li
					data-artifact-id={nav.id}
					class="group flex cursor-default items-center gap-1.5 rounded px-1.5 py-0.5 text-xs text-zinc-300 hover:bg-zinc-900"
					onpointerdown={(e) => onPointerDown(e, nav.id)}
					ondblclick={() => openExisting(nav.id, nav.name)}
				>
					<Route class="size-3.5 shrink-0 text-sky-500" />
					<span class="flex-1 truncate">{nav.name}</span>
					{#if editable}
						<button
							type="button"
							class="hidden text-zinc-500 hover:text-zinc-200 group-hover:inline"
							onclick={() => void rename(nav.id, nav.name)}>Rename</button
						>
						<button
							type="button"
							class="hidden text-zinc-500 hover:text-red-400 group-hover:inline"
							onclick={() => void del(nav.id, nav.name)}>Delete</button
						>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>
