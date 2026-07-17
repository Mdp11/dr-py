<script lang="ts">
	import { ChevronDown, ChevronRight, Plus, Route, Table } from '@lucide/svelte';
	import {
		canEdit,
		getArtifactHeaders,
		isArtifactDirty,
		openArtifactTab,
		openNavigationTab,
		removeArtifact,
		renameArtifact
	} from '$lib/state';
	// beginDrag/DragPayload live in tree-drag.svelte.ts, which is not re-exported
	// from `$lib/state` — Search.svelte and ContainmentTree.svelte import it the
	// same way (direct module path), so this mirrors the existing convention.
	import { beginDrag } from '$lib/state/tree-drag.svelte';

	type ArtifactKind = 'navigation' | 'table';

	type SectionConfig = {
		kind: ArtifactKind;
		title: string;
		/** Lowercase noun used in prompts/labels ("navigation" / "table"). */
		singular: string;
		icon: typeof Route;
		open: (opts: { artifactId: string | null; title: string }) => string;
	};

	// Drives both sidebar sections from one place: New / open (dblclick) /
	// rename / delete / drag all read `kind`/`title`/`singular`/`icon`/`open`
	// off the matching entry rather than being duplicated per section.
	const SECTIONS: SectionConfig[] = [
		{
			kind: 'navigation',
			title: 'Navigations',
			singular: 'navigation',
			icon: Route,
			open: (o) => openNavigationTab(o)
		},
		{
			kind: 'table',
			title: 'Tables',
			singular: 'table',
			icon: Table,
			open: (o) => openArtifactTab('table', o)
		}
	];

	let collapsed = $state<Record<ArtifactKind, boolean>>({ navigation: false, table: false });
	const editable = $derived(canEdit());

	function itemsFor(kind: ArtifactKind) {
		return getArtifactHeaders().filter((a) => a.kind === kind);
	}

	function openNew(cfg: SectionConfig): void {
		cfg.open({ artifactId: null, title: `New ${cfg.singular}` });
	}
	function openExisting(cfg: SectionConfig, id: string, name: string): void {
		cfg.open({ artifactId: id, title: name });
	}
	async function rename(cfg: SectionConfig, id: string, current: string): Promise<void> {
		const name = window.prompt(`Rename ${cfg.singular}`, current);
		if (name && name !== current) await renameArtifact(id, name);
	}
	async function del(cfg: SectionConfig, id: string, name: string): Promise<void> {
		if (window.confirm(`Delete ${cfg.singular} "${name}"?`)) await removeArtifact(id);
	}
	const DRAG_THRESHOLD_PX = 4;
	function onPointerDown(e: PointerEvent, cfg: SectionConfig, id: string): void {
		if (e.button !== 0 || !e.isPrimary) return;
		const sx = e.clientX;
		const sy = e.clientY;
		let started = false;
		const move = (ev: PointerEvent): void => {
			if (started) return;
			if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < DRAG_THRESHOLD_PX) return;
			started = true;
			beginDrag({ kind: 'artifact', id, artifactKind: cfg.kind }, true);
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

{#snippet section(cfg: SectionConfig)}
	{@const Icon = cfg.icon}
	{@const items = itemsFor(cfg.kind)}
	<section class="border-b border-border px-2 py-1.5">
		<div class="flex items-center justify-between">
			<button
				type="button"
				class="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
				onclick={() => (collapsed = { ...collapsed, [cfg.kind]: !collapsed[cfg.kind] })}
			>
				{#if collapsed[cfg.kind]}<ChevronRight class="size-3" />{:else}<ChevronDown
						class="size-3"
					/>{/if}
				{cfg.title}
				<span class="text-muted-foreground/50">({items.length})</span>
			</button>
			{#if editable}
				<button
					type="button"
					aria-label={`New ${cfg.singular}`}
					class="rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
					onclick={() => openNew(cfg)}
				>
					<Plus class="size-3.5" />
				</button>
			{/if}
		</div>
		{#if !collapsed[cfg.kind]}
			<ul class="mt-1 space-y-0.5">
				{#each items as item (item.id)}
					<li
						data-artifact-id={item.id}
						class="group flex cursor-default items-center gap-1.5 rounded px-1.5 py-0.5 text-xs text-foreground/80 transition-colors hover:bg-muted"
						onpointerdown={(e) => onPointerDown(e, cfg, item.id)}
						ondblclick={() => openExisting(cfg, item.id, item.name)}
					>
						<Icon class="size-3.5 shrink-0 text-info" />
						<span class="flex-1 truncate"
							>{item.name}{isArtifactDirty(cfg.kind, item.id) ? ' *' : ''}</span
						>
						{#if editable}
							<button
								type="button"
								class="hidden text-muted-foreground transition-colors hover:text-foreground group-hover:inline"
								onclick={() => void rename(cfg, item.id, item.name)}>Rename</button
							>
							<button
								type="button"
								class="hidden text-muted-foreground transition-colors hover:text-destructive group-hover:inline"
								onclick={() => void del(cfg, item.id, item.name)}>Delete</button
							>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</section>
{/snippet}

{#each SECTIONS as cfg (cfg.kind)}
	{@render section(cfg)}
{/each}
