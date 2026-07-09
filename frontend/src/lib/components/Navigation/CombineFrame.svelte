<script lang="ts">
	// The indigo-accented frame for a combination (`SetExpression`) node: a
	// plain-language operator picker, a dashed divider (glyph + word) between
	// consecutive parts, and — when this frame is ITSELF a combination's
	// operand (`chrome` set) — its own header sprouts the same feeds-note /
	// move-remove toolbar a part gets, plus the Difference `base` badge.
	// Nested-as-operand frames contribute their members wholesale (no steps
	// to feed), so unlike a PathCard/RefCard part they get no feeds chip.
	import { untrack } from 'svelte';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import {
		applyStructuralEdit,
		canEdit,
		getArtifactHeaders,
		getDraft,
		getSelectedPath,
		registerVisibleNode,
		selectNode,
		unregisterVisibleNode,
		updateDefinition
	} from '$lib/state';
	import {
		OP_DIVIDER,
		OP_LABEL,
		insertGroupEdit,
		insertNavigationEdit,
		insertRefEdit,
		moveOperandEdit,
		pathKey,
		removeOperandEdit,
		titleForPath,
		updateNodeAt,
		type NodePath,
		type StructuralEdit
	} from '$lib/navigation/tree';
	import type { NavigationDefinition, SetExpression } from '$lib/api/types';
	import NavigationNode from './NavigationNode.svelte';
	import RefCard from './RefCard.svelte';
	import OperandToolbar from './OperandToolbar.svelte';
	import StereotypePicker from '../Sidebar/StereotypePicker.svelte';
	import type { OperandChrome } from './chrome';

	let {
		tabId,
		path,
		node,
		chrome = null
	}: {
		tabId: string;
		path: NodePath;
		node: SetExpression;
		chrome?: OperandChrome | null;
	} = $props();

	const editable = $derived(canEdit());
	const draft = $derived(getDraft(tabId));
	const navHeaders = $derived(getArtifactHeaders().filter((a) => a.kind === 'navigation'));
	const title = $derived(draft ? titleForPath(draft.definition, path) : '');
	const isSelected = $derived(pathKey(getSelectedPath(tabId)) === pathKey(path));

	// One notch deeper tint per nesting level, capped at two notches — a
	// nested combination (a combination used as another's operand) reads as
	// "inside" its parent frame.
	const depth = $derived(path.length);
	const tint = $derived(
		depth === 0
			? 'bg-indigo-400/[0.035]'
			: depth === 1
				? 'bg-indigo-400/[0.05]'
				: 'bg-indigo-400/[0.07]'
	);

	// Registers/unregisters this frame's node on mount/unmount only — the store
	// mutation runs untracked so the reactive reads it performs (draft/preview
	// lookups) before an immediate run's first await don't get picked up as
	// dependencies of THIS effect (which would re-trigger it the moment the
	// run it just kicked off writes back into the store, looping forever).
	$effect(() => {
		const p = path;
		untrack(() => registerVisibleNode(tabId, p));
		return () => untrack(() => unregisterVisibleNode(tabId, p));
	});

	let libraryOpen = $state(false);

	// Field edits (operator) move no nodes → plain updateDefinition; operand
	// insert/remove/reorder are STRUCTURAL and must carry each expanded
	// node's state to its new position (see applyStructuralEdit).
	function mutate(next: (root: NavigationDefinition) => NavigationDefinition) {
		if (!draft) return;
		updateDefinition(tabId, next(draft.definition));
	}
	function structural(make: (root: NavigationDefinition) => StructuralEdit) {
		if (!draft) return;
		applyStructuralEdit(tabId, make(draft.definition));
	}
	function setOp(op: SetExpression['op']) {
		mutate((root) => updateNodeAt(root, path, (n) => ({ ...(n as SetExpression), op })));
	}

	function chromeFor(i: number): OperandChrome {
		return {
			parentPath: path,
			index: i,
			total: node.operands.length,
			stepIndex: node.operands[i].step_index ?? null,
			isBase: node.op === 'difference' && i === 0
		};
	}

	// Only the card CHROME (the click target itself, or a click that bubbled
	// up from something that isn't ANOTHER selectable card) selects this
	// node — a nested PathCard/RefCard/CombineFrame handles its own click,
	// and a control (button/select/input/label/summary/a) is that control's
	// own business.
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
	data-testid="combine-frame"
	data-node-path={pathKey(path)}
	data-selected={isSelected}
	aria-label={title}
	class="space-y-2 rounded-lg border border-indigo-400/35 {tint} p-3 text-xs"
	class:ring-1={isSelected}
	class:ring-sky-500={isSelected}
	onclick={onCardClick}
	onkeydown={onCardKeydown}
>
	<div class="flex flex-wrap items-center gap-2">
		<span class="font-mono text-[10px] text-indigo-400 uppercase tracking-[0.14em]"
			>Combination</span
		>
		<select
			aria-label="Combination operator"
			disabled={!editable}
			value={node.op}
			onchange={(e) => setOp(e.currentTarget.value as SetExpression['op'])}
			class="rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-xs"
		>
			{#each Object.entries(OP_LABEL) as [value, label] (value)}
				<option {value}>{label}</option>
			{/each}
		</select>
		{#if chrome?.isBase}
			<span
				data-testid="base-badge"
				class="rounded bg-amber-500/10 px-1 font-mono text-[10px] text-amber-400">base</span
			>
		{/if}
		{#if chrome}
			<span class="text-[11px] text-zinc-500 italic"
				>contributes its members — no steps to feed</span
			>
		{/if}
		<span class="flex-1"></span>
		{#if chrome}
			<OperandToolbar
				canMoveUp={chrome.index > 0}
				canMoveDown={chrome.index < chrome.total - 1}
				onUp={() => structural((r) => moveOperandEdit(r, chrome.parentPath, chrome.index, 'up'))}
				onDown={() =>
					structural((r) => moveOperandEdit(r, chrome.parentPath, chrome.index, 'down'))}
				onRemove={() => structural((r) => removeOperandEdit(r, chrome.parentPath, chrome.index))}
			/>
		{/if}
	</div>

	<div class="space-y-1.5">
		{#each node.operands as op, i (i)}
			{#if i > 0}
				<div
					data-testid="op-divider"
					class="flex items-center gap-2 text-[10px] text-indigo-300/70"
				>
					<span class="h-px flex-1 bg-indigo-400/20"></span>
					{OP_DIVIDER[node.op]}
					<span class="h-px flex-1 bg-indigo-400/20"></span>
				</div>
			{/if}
			{#if op.definition}
				<NavigationNode {tabId} path={[...path, i]} chrome={chromeFor(i)} />
			{:else if op.ref}
				<RefCard {tabId} path={[...path, i]} refId={op.ref} chrome={chromeFor(i)} />
			{/if}
		{/each}
	</div>

	{#if editable}
		<div class="flex items-center gap-3 border-t border-indigo-400/20 pt-2">
			<DropdownMenu.Root>
				<DropdownMenu.Trigger class="text-sky-500 hover:text-sky-300">
					+ Add another part ▾
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="start" class="w-72">
					<DropdownMenu.Item
						class="flex flex-col items-start gap-0.5 py-1.5"
						onSelect={() => structural((r) => insertNavigationEdit(r, path))}
					>
						<button type="button" tabindex="-1" class="pointer-events-none text-left text-zinc-100"
							>A new path</button
						>
						<span class="block text-[11px] text-zinc-500">
							An empty path — build it with Start / Follow / Keep only
						</span>
					</DropdownMenu.Item>
					<DropdownMenu.Item
						class="flex flex-col items-start gap-0.5 py-1.5"
						onSelect={() => (libraryOpen = true)}
					>
						<button type="button" tabindex="-1" class="pointer-events-none text-left text-zinc-100"
							>A saved navigation…</button
						>
						<span class="block text-[11px] text-zinc-500">
							Pick one from the library; it stays linked, not copied
						</span>
					</DropdownMenu.Item>
					<DropdownMenu.Item
						class="flex flex-col items-start gap-0.5 py-1.5"
						onSelect={() => structural((r) => insertGroupEdit(r, path))}
					>
						<button type="button" tabindex="-1" class="pointer-events-none text-left text-zinc-100"
							>A nested combination</button
						>
						<span class="block text-[11px] text-zinc-500">
							A combination inside this one, with its own operator
						</span>
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
			<StereotypePicker
				mode="create"
				names={navHeaders.map((h) => h.name)}
				onPick={(name) => {
					const h = navHeaders.find((x) => x.name === name);
					if (h) structural((r) => insertRefEdit(r, path, h.id));
				}}
				open={libraryOpen}
				onOpenChange={(v) => (libraryOpen = v)}
				searchPlaceholder="Add saved navigation…"
			>
				{#snippet trigger()}<span class="inline-block h-0 w-0"></span>{/snippet}
			</StereotypePicker>
		</div>
	{/if}
</div>
