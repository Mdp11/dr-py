<script lang="ts">
	import { ChevronDown, ChevronRight, Plus, Route } from '@lucide/svelte';
	import { KIND_ICONS, type ArtifactKind } from '$lib/artifacts/kinds';
	import {
		canEdit,
		getArtifactHeaders,
		getDynamicTabs,
		isArtifactDirty,
		openArtifactTab,
		openNavigationTab,
		removeArtifact,
		renameArtifact,
		setActiveTab,
		stagedArtifactState,
		stagedCreateSourceTab
	} from '$lib/state';
	// beginDrag/DragPayload live in tree-drag.svelte.ts, which is not re-exported
	// from `$lib/state` — Search.svelte and ContainmentTree.svelte import it the
	// same way (direct module path), so this mirrors the existing convention.
	import { beginDrag } from '$lib/state/tree-drag.svelte';
	import { confirm } from '$lib/state/confirm.svelte';
	import { isTempId } from '$lib/state/ops';

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
			icon: KIND_ICONS.navigation,
			open: (o) => openNavigationTab(o)
		},
		{
			kind: 'table',
			title: 'Tables',
			singular: 'table',
			icon: KIND_ICONS.table,
			open: (o) => openArtifactTab('table', o)
		},
		{
			kind: 'code_snippet',
			title: 'Snippets',
			singular: 'snippet',
			icon: KIND_ICONS.code_snippet,
			open: (o) => openArtifactTab('snippet', o)
		},
		{
			kind: 'exporter',
			title: 'Exporters',
			singular: 'exporter',
			icon: KIND_ICONS.exporter,
			open: (o) => openArtifactTab('exporter', o)
		},
		{
			kind: 'validation_rules',
			title: 'Rules',
			singular: 'Rule set',
			icon: KIND_ICONS.validation_rules,
			open: (o) => openArtifactTab('rules', o)
		}
	];

	let collapsed = $state<Record<ArtifactKind, boolean>>({
		navigation: false,
		table: false,
		code_snippet: false,
		exporter: false,
		validation_rules: false
	});
	const editable = $derived(canEdit());

	// Staged badge, mirroring "Staged elements" (Sidebar/StagedSection.svelte).
	// `deleted` is unreachable here — the overlay hides staged-deleted rows — but
	// is mapped anyway so the record stays total against stagedArtifactState.
	const STAGED_BADGE: Record<'new' | 'edited' | 'deleted', { label: string; cls: string }> = {
		new: { label: 'new', cls: 'text-success' },
		edited: { label: 'edited', cls: 'text-warning' },
		deleted: { label: 'deleted', cls: 'text-destructive' }
	};

	// getArtifactHeaders() is the STAGED OVERLAY (see artifacts.svelte.ts), so
	// these rows already include uncommitted creates (under their temp id, with
	// their staged name) and exclude uncommitted deletes. Nothing below needs to
	// consult the staged buffer to decide WHAT to render — only how to badge it.
	function itemsFor(kind: ArtifactKind) {
		return getArtifactHeaders().filter((a) => a.kind === kind);
	}

	function openNew(cfg: SectionConfig): void {
		cfg.open({ artifactId: null, title: `New ${cfg.singular}` });
	}
	function openExisting(cfg: SectionConfig, id: string, name: string): void {
		// A staged create has no server-side row, so there is nothing for a fresh
		// editor tab to load — focus the tab it was staged from instead.
		//
		// That tab may be GONE: closing an editor clears its draft and releases its
		// lease but does NOT revert the staged create, so the recorded source tab id
		// outlives the tab. Activating a dead id would leave `_activeTab` matching no
		// pane and blank the workspace, so check it is still open and otherwise do
		// nothing — the row stays in the sidebar and the DiffDrawer remains the way
		// to review or discard the staged create.
		if (isTempId(id)) {
			const tab = stagedCreateSourceTab(id);
			if (tab !== null && getDynamicTabs().some((t) => t.id === tab)) setActiveTab(tab);
			return;
		}
		cfg.open({ artifactId: id, title: name });
	}
	async function rename(cfg: SectionConfig, id: string, current: string): Promise<void> {
		const name = window.prompt(`Rename ${cfg.singular}`, current);
		if (name && name !== current) await renameArtifact(id, name);
	}
	async function del(cfg: SectionConfig, id: string, name: string): Promise<void> {
		// A delete is STAGED, not immediate: discarding the batch brings the
		// artifact — and its view placements — straight back. Confirm still
		// runs BEFORE removeArtifact, so cancelling here never strands the
		// delete-intent lease that staging would acquire.
		const ok = await confirm({
			title: `Delete ${cfg.singular}`,
			description: `Delete "${name}"? It is destroyed when you commit; discard the batch to undo.`,
			confirmLabel: 'Delete',
			variant: 'destructive'
		});
		if (ok) await removeArtifact(id);
	}
	const DRAG_THRESHOLD_PX = 4;
	function onPointerDown(e: PointerEvent, cfg: SectionConfig, id: string): void {
		if (e.button !== 0 || !e.isPrimary) return;
		// Drag places the artifact in the view, which stores a bare {id, kind}
		// ref. A temp id would persist a ref to an artifact that does not exist
		// and — once the commit re-keys it to a real id — never will.
		if (isTempId(id)) return;
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
					{@const staged = stagedArtifactState(item.id)}
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
						{#if cfg.kind === 'code_snippet'}
							{#each (item.entry_points ?? []).filter((e) => e !== 'script') as ep (ep)}
								<span class="rounded bg-muted px-1 text-[10px] text-muted-foreground">{ep}</span>
							{/each}
						{/if}
						{#if staged !== null}
							<span
								data-staged-state={staged}
								class="font-mono text-[10px] {STAGED_BADGE[staged].cls}"
							>
								{STAGED_BADGE[staged].label}
							</span>
						{/if}
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
