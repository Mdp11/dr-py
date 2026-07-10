<script lang="ts">
	// The sentence-layout card for a single Path: a numbered rail (Start ->
	// hops -> ghost filter dots) read like a sentence ("Start from … Follow …
	// to … Keep only …"), topped with the always-live header (title, status,
	// and — only when this path is a combination's operand — the feeds chip
	// and move/remove toolbar the parent hands down via `chrome`).
	import { untrack } from 'svelte';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import {
		applyStructuralEdit,
		canEdit,
		getArtifactHeaders,
		getDraft,
		getMetamodel,
		getSelectedPath,
		registerVisibleNode,
		selectNode,
		unregisterVisibleNode,
		updateDefinition
	} from '$lib/state';
	import {
		chainColumns,
		elementStartScope,
		emptyCombine,
		insertGroupEdit,
		insertNavigationEdit,
		insertRefEdit,
		moveOperandEdit,
		pathKey,
		precedingTargetTypes,
		readElementStart,
		removeOperandEdit,
		setOperandStepIndex,
		titleForPath,
		updateNodeAt,
		type NodePath,
		type StructuralEdit
	} from '$lib/navigation/tree';
	import { effectivePropertiesForTypes } from '$lib/metamodel/helpers';
	import type {
		NavFilterStep,
		NavigationDefinition,
		NavRelationshipStep,
		NavScope,
		NavStepItem,
		PathNavigation
	} from '$lib/api/types';
	import ChainBadge from './ChainBadge.svelte';
	import StatusChip from './StatusChip.svelte';
	import FeedsChip from './FeedsChip.svelte';
	import OperandToolbar from './OperandToolbar.svelte';
	import ScopeEditor from './ScopeEditor.svelte';
	import ElementStartPicker from './ElementStartPicker.svelte';
	import NavigationNode from './NavigationNode.svelte';
	import RelationshipStepRow from './RelationshipStepRow.svelte';
	import FilterStepRow from './FilterStepRow.svelte';
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
		node: PathNavigation;
		chrome?: OperandChrome | null;
	} = $props();

	const editable = $derived(canEdit());
	const draft = $derived(getDraft(tabId));
	const mm = $derived(getMetamodel());
	const navHeaders = $derived(getArtifactHeaders().filter((a) => a.kind === 'navigation'));
	const title = $derived(draft ? titleForPath(draft.definition, path) : '');
	const isSelected = $derived(pathKey(getSelectedPath(tabId)) === pathKey(path));

	// Registers/unregisters this card's node on mount/unmount only — the store
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

	function patch(next: Partial<PathNavigation>) {
		if (!draft) return;
		updateDefinition(
			tabId,
			updateNodeAt(draft.definition, path, (n) => ({ ...(n as PathNavigation), ...next }))
		);
	}
	// Composing an alternative-branch set out of THIS path (bare-path
	// auto-wrap): a STRUCTURAL edit that moves nodes, so it goes through
	// `applyStructuralEdit` (which carries expanded/preview state along with
	// the moved nodes) rather than `patch` (which only ever replaces
	// PathNavigation fields in place, moving nothing).
	function structural(make: (root: NavigationDefinition) => StructuralEdit) {
		if (!draft) return;
		applyStructuralEdit(tabId, make(draft.definition));
	}

	// Types flowing into relationship step `i` (rel-type/target-type picker
	// scope), and the property-picker scope for filter step `i` — both derive
	// from the nearest preceding relationship step's target_types, else the
	// path's own start types. See `precedingTargetTypes`.
	function sourceTypesFor(i: number): string[] {
		return precedingTargetTypes(node, i);
	}
	function propertyNamesFor(i: number): string[] {
		if (!mm) return [];
		return effectivePropertiesForTypes(mm, precedingTargetTypes(node, i)).map((p) => p.name);
	}

	function setStep(i: number, next: NavStepItem): void {
		const steps = node.steps.map((s, idx) => (idx === i ? next : s));
		patch({ steps });
	}
	function removeStep(i: number): void {
		patch({ steps: node.steps.filter((_, idx) => idx !== i) });
	}
	function addRelationshipStep(): void {
		const step: NavRelationshipStep = {
			kind: 'relationship',
			relationship_type: '',
			direction: 'out',
			target_types: [],
			children: []
		};
		patch({ steps: [...node.steps, step] });
	}
	function addFilterStep(): void {
		const step: NavFilterStep = { kind: 'filter', criteria: [] };
		patch({ steps: [...node.steps, step] });
	}

	type StartMode = 'scope' | 'element' | 'combine';
	const startMode = $derived<StartMode>(
		node.start.kind === 'set_op'
			? 'combine'
			: readElementStart(node.start) !== null
				? 'element'
				: 'scope'
	);
	function setStartMode(mode: StartMode): void {
		if (mode === 'scope') patch({ start: { kind: 'scope', types: [], criteria: [] } });
		else if (mode === 'element') patch({ start: elementStartScope('') });
		else patch({ start: emptyCombine() });
	}

	// The rail's column number for relationship step i = 1 + how many
	// relationship steps precede it (column 0 is always the start).
	function columnFor(i: number): number {
		let n = 1;
		for (let j = 0; j < i; j++) if (node.steps[j].kind === 'relationship') n++;
		return n;
	}

	// Only the card CHROME (the click target itself, not something it
	// bubbled up from) selects this node — a click landing on any inner
	// control (button/select/input/label/summary/a) is that control's own
	// business, and a click landing on (or inside) a NESTED selectable card
	// (a combination used as this path's `start`) is that nested card's own
	// business too — otherwise it would bubble here and stomp the deeper
	// selection the nested card just made.
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

	function setFeeds(v: number | null): void {
		if (!draft || !chrome) return;
		updateDefinition(
			tabId,
			setOperandStepIndex(draft.definition, chrome.parentPath, chrome.index, v)
		);
	}
</script>

<div
	role="button"
	tabindex="0"
	data-testid="path-card"
	data-node-path={pathKey(path)}
	data-selected={isSelected}
	class="space-y-2 rounded border border-border bg-card/40 p-2 text-xs"
	class:ring-1={isSelected}
	class:ring-ring={isSelected}
	onclick={onCardClick}
	onkeydown={onCardKeydown}
>
	<div class="flex flex-wrap items-center gap-2">
		<span class="font-medium text-foreground/80">{title || 'Path'}</span>
		<StatusChip {tabId} {path} />
		{#if chrome?.isBase}
			<span
				data-testid="base-badge"
				class="rounded bg-warning/15 px-1 font-mono text-[10px] text-warning">base</span
			>
		{/if}
		{#if chrome}
			<FeedsChip
				columns={chainColumns(node)}
				value={chrome.stepIndex}
				onPick={setFeeds}
				disabled={!editable}
			/>
			{#if editable}
				<OperandToolbar
					canMoveUp={chrome.index > 0}
					canMoveDown={chrome.index < chrome.total - 1}
					onUp={() => structural((r) => moveOperandEdit(r, chrome.parentPath, chrome.index, 'up'))}
					onDown={() =>
						structural((r) => moveOperandEdit(r, chrome.parentPath, chrome.index, 'down'))}
					onRemove={() => structural((r) => removeOperandEdit(r, chrome.parentPath, chrome.index))}
				/>
			{/if}
		{/if}
	</div>

	<div class="relative space-y-1">
		<span class="pointer-events-none absolute top-2 bottom-2 left-[9px] w-px bg-border"></span>
		<div class="relative flex items-baseline gap-2.5 py-0.5">
			<ChainBadge value={0} tone="start" />
			<div class="flex min-h-[22px] flex-1 flex-wrap items-center gap-1.5">
				<span class="text-muted-foreground">Start from</span>
				<select
					aria-label="Start mode"
					disabled={!editable}
					value={startMode}
					onchange={(e) => setStartMode(e.currentTarget.value as StartMode)}
					class="rounded border border-input bg-card px-1 py-0.5"
				>
					<option value="scope">all matching</option>
					<option value="element">one element</option>
					<option value="combine">a combination</option>
				</select>
			</div>
		</div>
		{#if node.start.kind === 'scope'}
			{#if startMode === 'element'}
				<div class="relative pl-7">
					<ElementStartPicker
						value={readElementStart(node.start)}
						onPick={(id) => patch({ start: elementStartScope(id) })}
					/>
				</div>
			{:else}
				<div class="relative pl-7">
					<ScopeEditor scope={node.start} onChange={(s: NavScope) => patch({ start: s })} />
				</div>
			{/if}
		{:else if node.start.kind === 'set_op'}
			<div class="relative pl-7">
				<NavigationNode {tabId} path={[...path, 'start']} />
			</div>
		{/if}
		{#each node.steps as step, i (i)}
			{#if step.kind === 'relationship'}
				<RelationshipStepRow
					step={step as NavRelationshipStep}
					index={i}
					column={columnFor(i)}
					sourceTypes={sourceTypesFor(i)}
					onChange={setStep}
					onRemove={removeStep}
				/>
			{:else}
				<FilterStepRow
					step={step as NavFilterStep}
					index={i}
					propertyNames={propertyNamesFor(i)}
					onChange={setStep}
					onRemove={removeStep}
				/>
			{/if}
		{/each}
	</div>

	{#if editable}
		<div class="flex items-center gap-2 pl-7">
			<button
				type="button"
				class="rounded border border-dashed border-input px-2 py-1 text-info/90 hover:border-ring hover:text-info"
				onclick={addRelationshipStep}
			>
				+ Follow a relationship
			</button>
			<button
				type="button"
				class="rounded border border-dashed border-input px-2 py-1 text-info/90 hover:border-ring hover:text-info"
				onclick={addFilterStep}
			>
				+ Keep only…
			</button>
		</div>
	{/if}

	{#if editable}
		<div class="flex items-center gap-3 border-t border-border pt-2">
			<DropdownMenu.Root>
				<DropdownMenu.Trigger class="text-info/90 hover:text-info">
					Combine with… ▾
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="start" class="w-72">
					<DropdownMenu.Item
						class="flex flex-col items-start gap-0.5 py-1.5"
						onSelect={() => structural((r) => insertNavigationEdit(r, path))}
					>
						<button
							type="button"
							tabindex="-1"
							class="pointer-events-none text-left text-foreground">A new path</button
						>
						<span class="block text-[11px] text-muted-foreground/70">
							Turns this into a Union of this path + a new empty one
						</span>
					</DropdownMenu.Item>
					<DropdownMenu.Item
						class="flex flex-col items-start gap-0.5 py-1.5"
						onSelect={() => (libraryOpen = true)}
					>
						<button
							type="button"
							tabindex="-1"
							class="pointer-events-none text-left text-foreground">A saved navigation…</button
						>
						<span class="block text-[11px] text-muted-foreground/70">
							Turns this into a Union of this path + a link to a saved navigation
						</span>
					</DropdownMenu.Item>
					<DropdownMenu.Item
						class="flex flex-col items-start gap-0.5 py-1.5"
						onSelect={() => structural((r) => insertGroupEdit(r, path))}
					>
						<button
							type="button"
							tabindex="-1"
							class="pointer-events-none text-left text-foreground">A nested combination</button
						>
						<span class="block text-[11px] text-muted-foreground/70">
							Turns this into a Union of this path + a nested combination
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

	<details>
		<summary class="cursor-pointer text-muted-foreground/70 select-none hover:text-muted-foreground"
			>Options</summary
		>
		<label
			class="mt-1.5 flex items-center gap-1.5 pl-2 text-muted-foreground"
			title="When on, a chain never revisits an element it already contains"
		>
			<input
				type="checkbox"
				checked={node.exclude_visited}
				disabled={!editable}
				onchange={(e) => patch({ exclude_visited: e.currentTarget.checked })}
			/>
			Exclude visited elements
		</label>
	</details>
</div>
