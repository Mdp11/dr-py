<script lang="ts">
	// A LINKED library navigation used as a combination part. It is not
	// editable inline and carries no definition, so the store cannot evaluate
	// it (`nodeAt` returns null for a ref operand) — hence the muted `linked`
	// chip instead of a chain count, and a feeds popover offering only the
	// last-step default (a ref's column count is unknowable client-side
	// without fetching it; out of scope).
	import { ExternalLink } from '@lucide/svelte';
	import {
		applyStructuralEdit,
		artifactHeaderById,
		canEdit,
		getDraft,
		getSelectedPath,
		selectNode,
		updateDefinition
	} from '$lib/state';
	import { openNavigationTab } from '$lib/state/workspace.svelte';
	import {
		moveOperandEdit,
		pathKey,
		removeOperandEdit,
		setOperandStepIndex,
		type NodePath
	} from '$lib/navigation/tree';
	import type { OperandChrome } from './chrome';
	import FeedsChip from './FeedsChip.svelte';
	import OperandToolbar from './OperandToolbar.svelte';
	import StatusChip from './StatusChip.svelte';

	let {
		tabId,
		path,
		refId,
		chrome
	}: { tabId: string; path: NodePath; refId: string; chrome: OperandChrome } = $props();

	const editable = $derived(canEdit());
	const header = $derived(artifactHeaderById(refId));
	const name = $derived(header?.name ?? refId);
	const isSelected = $derived(pathKey(getSelectedPath(tabId)) === pathKey(path));

	// No visibility registration here — a ref has no evaluable node (`nodeAt`
	// returns null for it), so there is nothing for auto-run to preview.

	function setFeeds(v: number | null): void {
		const draft = getDraft(tabId);
		if (!draft) return;
		updateDefinition(
			tabId,
			setOperandStepIndex(draft.definition, chrome.parentPath, chrome.index, v)
		);
	}
	function move(dir: 'up' | 'down'): void {
		const draft = getDraft(tabId);
		if (!draft) return;
		applyStructuralEdit(
			tabId,
			moveOperandEdit(draft.definition, chrome.parentPath, chrome.index, dir)
		);
	}
	function remove(): void {
		const draft = getDraft(tabId);
		if (!draft) return;
		applyStructuralEdit(
			tabId,
			removeOperandEdit(draft.definition, chrome.parentPath, chrome.index)
		);
	}

	// Same containment guard as PathCard/CombineFrame: a click bubbling up
	// from a control, or from another selectable card nested inside this
	// one's own chrome, is that element's business, not this card's.
	function onCardClick(e: MouseEvent): void {
		const target = e.target as HTMLElement;
		if (target.closest('button, select, input, label, summary, a')) return;
		const nearestCard = target.closest(
			'[data-testid="path-card"], [data-testid="combine-frame"], [data-testid="ref-card"]'
		);
		if (nearestCard && nearestCard !== (e.currentTarget as HTMLElement)) return;
		selectNode(tabId, path);
	}
	function onCardKeydown(e: KeyboardEvent): void {
		if (e.key === 'Enter' && e.target === e.currentTarget) selectNode(tabId, path);
	}
</script>

<div
	role="button"
	tabindex="0"
	data-testid="ref-card"
	data-node-path={pathKey(path)}
	data-selected={isSelected}
	class="flex flex-wrap items-center gap-2 rounded border border-border bg-card/40 px-2 py-1.5 text-xs"
	class:ring-1={isSelected}
	class:ring-ring={isSelected}
	onclick={onCardClick}
	onkeydown={onCardKeydown}
>
	<span class="font-medium text-info">⧉ {name}</span>
	<span class="text-muted-foreground/70">saved navigation</span>
	<StatusChip {tabId} {path} kind="ref" />
	{#if chrome.isBase}
		<span
			data-testid="base-badge"
			class="rounded bg-warning/15 px-1 font-mono text-[10px] text-warning">base</span
		>
	{/if}
	<span class="flex-1"></span>
	<FeedsChip columns={[{ index: 0, label: 'Start' }]} value={chrome.stepIndex} onPick={setFeeds} />
	<button
		type="button"
		aria-label="Open saved navigation"
		class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-info hover:bg-muted hover:text-info/80"
		onclick={() => openNavigationTab({ artifactId: refId, title: name })}
	>
		<ExternalLink class="size-3" />
		open ↗
	</button>
	{#if editable}
		<OperandToolbar
			canMoveUp={chrome.index > 0}
			canMoveDown={chrome.index < chrome.total - 1}
			onUp={() => move('up')}
			onDown={() => move('down')}
			onRemove={remove}
		/>
	{/if}
</div>
