<script lang="ts">
	// The sentence-layout card for a single Path: a numbered rail (Start ->
	// hops -> ghost filter dots) read like a sentence ("Start from … Follow …
	// to … Keep only …"), topped with the always-live header (title, status,
	// and — only when this path is a combination's operand — the feeds chip
	// and move/remove toolbar the parent hands down via `chrome`).
	import { untrack } from 'svelte';
	import { ChevronDown, ChevronRight, Pencil } from '@lucide/svelte';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import {
		applyStructuralEdit,
		canEdit,
		getArtifactHeaders,
		getDraft,
		getMetamodel,
		getSelectedPath,
		isCardCollapsed,
		registerVisibleNode,
		selectNode,
		setCardCollapsed,
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
		nodeLabel,
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
	import {
		effectivePropertiesForTypes,
		frontierTypesAt,
		propertyStepTargetTypes
	} from '$lib/metamodel/helpers';
	import type { PropertyItem } from '$lib/search/property-ops';
	import type {
		NavFilterStep,
		NavigationDefinition,
		NavPropertyStep,
		NavRelationshipStep,
		NavScope,
		NavScriptStep,
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
	import PropertyStepRow from './PropertyStepRow.svelte';
	import ScriptStepRow from './ScriptStepRow.svelte';
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

	// UI disclosure: a collapsed card keeps its header (title, status, chips)
	// plus a one-line summary and hides the editing body. Store-keyed (NOT
	// component-local $state) so it survives a remount — an auto-wrap into a
	// combination, a dialog reopen, or an index-keyed editor reuse used to
	// silently reset it back to expanded. It is also deliberately NOT the
	// store's `_expanded` set, which tracks node VISIBILITY for preview
	// auto-runs (see navigation-editor.svelte.ts) — previews/status stay live
	// while collapsed. The default (no explicit choice yet) is collapsed for
	// embedded (table-settings) drafts and expanded for standalone navigation
	// tabs; see `isCardCollapsed`.
	const collapsed = $derived(isCardCollapsed(tabId, path));

	// Inline rename: the user-chosen name overrides the automatic "Path A"
	// lettering (clearing it restores the letter — `name: null`).
	let renaming = $state(false);
	let renameEl = $state<HTMLInputElement | null>(null);
	$effect(() => {
		if (renaming) renameEl?.focus();
	});
	function commitRename(value: string): void {
		if (!renaming) return; // Escape already cancelled; ignore the trailing blur
		renaming = false;
		const trimmed = value.trim();
		if ((node.name ?? '') === trimmed || (!node.name && trimmed === '')) return;
		patch({ name: trimmed === '' ? null : trimmed });
	}

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
	// from the frontier at that point in the chain: the metamodel-aware walk
	// (`frontierTypesAt`) when a metamodel is loaded, else the pure fallback
	// (`precedingTargetTypes`, which gives up to "any type" at a property step).
	function frontierFor(i: number): string[] {
		return mm ? frontierTypesAt(mm, node, i) : precedingTargetTypes(node, i);
	}
	function sourceTypesFor(i: number): string[] {
		return frontierFor(i);
	}
	function propertyNamesFor(i: number): string[] {
		if (!mm) return [];
		return effectivePropertiesForTypes(mm, frontierFor(i)).map((p) => p.name);
	}
	function propertyItemsForStep(i: number): PropertyItem[] {
		if (!mm) return [];
		return effectivePropertiesForTypes(mm, frontierFor(i)).map((p) => ({
			name: p.name,
			datatype: p.datatype
		}));
	}
	// First step index whose configured property can never continue the chain
	// (not an element reference anywhere reachable) — everything past it is
	// unreachable, so the add/insert affordances close down there.
	const blockedAt = $derived.by((): number | null => {
		if (!mm) return null;
		for (let i = 0; i < node.steps.length; i++) {
			const s = node.steps[i];
			if (s.kind !== 'property' || !s.property_name) continue;
			if (propertyStepTargetTypes(mm, frontierTypesAt(mm, node, i), s.property_name).length === 0)
				return i;
		}
		return null;
	});

	function setStep(i: number, next: NavStepItem): void {
		const steps = node.steps.map((s, idx) => (idx === i ? next : s));
		patch({ steps });
	}
	function removeStep(i: number): void {
		patch({ steps: node.steps.filter((_, idx) => idx !== i) });
	}
	function emptyRelationshipStep(): NavRelationshipStep {
		return {
			kind: 'relationship',
			relationship_type: '',
			direction: 'out',
			target_types: [],
			children: []
		};
	}
	/** Splice a fresh step in BEFORE step `i` — the between-steps insert zones;
	 * `i === steps.length` is the plain append the trailing buttons use. */
	function insertStep(i: number, step: NavStepItem): void {
		patch({ steps: [...node.steps.slice(0, i), step, ...node.steps.slice(i)] });
	}
	function emptyPropertyStep(): NavPropertyStep {
		return { kind: 'property', property_name: '' };
	}
	function addRelationshipStep(): void {
		insertStep(node.steps.length, emptyRelationshipStep());
	}
	function addFilterStep(): void {
		insertStep(node.steps.length, { kind: 'filter', criteria: [] });
	}
	function addPropertyStep(): void {
		insertStep(node.steps.length, emptyPropertyStep());
	}
	function addScriptStep(): void {
		insertStep(node.steps.length, { kind: 'script', snippet: {}, comment: null });
	}

	type StartMode = 'scope' | 'element' | 'combine' | 'row';
	const startMode = $derived<StartMode>(
		node.start.kind === 'set_op'
			? 'combine'
			: node.start.kind === 'row'
				? 'row'
				: readElementStart(node.start) !== null
					? 'element'
					: 'scope'
	);
	// Row-rooting is only meaningful where a caller supplies a row binding —
	// an embedded table-column editor. A standalone tab must never author a
	// RowStart (an unbound one is unevaluable), so the option is gated on the
	// draft's context; `startMode === 'row'` keeps an already-row-rooted
	// payload renderable wherever it appears.
	const rowStartAvailable = $derived(draft?.embedded?.rowContext === true);
	function setStartMode(mode: StartMode): void {
		if (mode === 'row') patch({ start: { kind: 'row' } });
		else if (mode === 'scope') patch({ start: { kind: 'scope', types: [], criteria: [] } });
		else if (mode === 'element') patch({ start: elementStartScope('') });
		else patch({ start: emptyCombine() });
	}

	// The rail's column number for a hop step i = 1 + how many hop steps
	// (relationship OR property — both advance the chain, only filter doesn't)
	// precede it (column 0 is always the start).
	function columnFor(i: number): number {
		let n = 1;
		for (let j = 0; j < i; j++) if (node.steps[j].kind !== 'filter') n++;
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
		<button
			type="button"
			data-testid="path-collapse-toggle"
			aria-label={collapsed ? 'Expand path' : 'Collapse path'}
			aria-expanded={!collapsed}
			class="shrink-0 text-muted-foreground/70 transition-colors hover:text-foreground"
			onclick={() => setCardCollapsed(tabId, path, !collapsed)}
		>
			{#if collapsed}<ChevronRight class="size-3.5" />{:else}<ChevronDown class="size-3.5" />{/if}
		</button>
		{#if renaming}
			<input
				bind:this={renameEl}
				data-testid="path-name-input"
				aria-label="Path name"
				class="w-40 rounded border border-input bg-card px-1.5 py-0.5 text-xs"
				placeholder={title || 'Path'}
				value={node.name ?? ''}
				onblur={(e) => commitRename(e.currentTarget.value)}
				onkeydown={(e) => {
					if (e.key === 'Enter') commitRename(e.currentTarget.value);
					else if (e.key === 'Escape') renaming = false;
				}}
			/>
		{:else}
			<span class="font-medium text-foreground/80">{title || 'Path'}</span>
			{#if editable}
				<button
					type="button"
					data-testid="path-rename-button"
					aria-label="Rename path"
					title="Rename this path (empty restores the automatic name)"
					class="shrink-0 text-muted-foreground/50 transition-colors hover:text-foreground"
					onclick={() => (renaming = true)}
				>
					<Pencil class="size-3" />
				</button>
			{/if}
		{/if}
		<StatusChip {tabId} {path} />
		{#if collapsed}
			<span class="min-w-0 truncate text-muted-foreground/70" title={nodeLabel(node)}>
				{nodeLabel(node)}
			</span>
		{/if}
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

	{#if !collapsed}
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
						{#if rowStartAvailable || startMode === 'row'}
							<option value="row">the row's element</option>
						{/if}
					</select>
				</div>
			</div>
			{#if node.start.kind === 'row'}
				<div class="relative pl-7">
					<span class="text-muted-foreground italic">each row's element</span>
				</div>
			{:else if node.start.kind === 'scope'}
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
				{#if editable && (blockedAt === null || i <= blockedAt)}
					<!-- Hover-revealed insert zone BEFORE step i, so a forgotten step
					     (say, a property check) can be added in place instead of
					     deleting and re-adding everything after it. Constant height:
					     the buttons fade in via opacity, so nothing shifts on hover;
					     keyboard focus reveals them too. Suppressed past a property
					     dead end — nothing reachable there to insert before. -->
					<div
						data-testid="insert-step-zone"
						class="group/insert relative flex h-3.5 items-center gap-1.5 pl-7"
					>
						<button
							type="button"
							aria-label="Insert relationship step here"
							title="Insert a 'Follow a relationship' step here"
							class="rounded border border-dashed border-input px-1.5 text-[10px] leading-3 text-info/90 opacity-0 transition-opacity group-hover/insert:opacity-100 hover:border-ring hover:text-info focus-visible:opacity-100"
							onclick={() => insertStep(i, emptyRelationshipStep())}
						>
							+ relationship
						</button>
						<button
							type="button"
							aria-label="Insert condition step here"
							title="Insert a 'Keep only…' step here"
							class="rounded border border-dashed border-input px-1.5 text-[10px] leading-3 text-info/90 opacity-0 transition-opacity group-hover/insert:opacity-100 hover:border-ring hover:text-info focus-visible:opacity-100"
							onclick={() => insertStep(i, { kind: 'filter', criteria: [] })}
						>
							+ condition
						</button>
						<button
							type="button"
							aria-label="Insert property step here"
							title="Insert a 'Go to property' step here"
							class="rounded border border-dashed border-input px-1.5 text-[10px] leading-3 text-info/90 opacity-0 transition-opacity group-hover/insert:opacity-100 hover:border-ring hover:text-info focus-visible:opacity-100"
							onclick={() => insertStep(i, emptyPropertyStep())}
						>
							+ property
						</button>
						<button
							type="button"
							aria-label="Insert script step here"
							title="Insert a 'Script' step here"
							class="rounded border border-dashed border-input px-1.5 text-[10px] leading-3 text-info/90 opacity-0 transition-opacity group-hover/insert:opacity-100 hover:border-ring hover:text-info focus-visible:opacity-100"
							onclick={() => insertStep(i, { kind: 'script', snippet: {}, comment: null })}
						>
							+ script
						</button>
					</div>
				{/if}
				<div class:opacity-50={blockedAt !== null && i > blockedAt}>
					{#if step.kind === 'relationship'}
						<RelationshipStepRow
							step={step as NavRelationshipStep}
							index={i}
							column={columnFor(i)}
							sourceTypes={sourceTypesFor(i)}
							onChange={setStep}
							onRemove={removeStep}
						/>
					{:else if step.kind === 'property'}
						<PropertyStepRow
							step={step as NavPropertyStep}
							index={i}
							column={columnFor(i)}
							items={propertyItemsForStep(i)}
							deadEnd={blockedAt === i}
							onChange={setStep}
							onRemove={removeStep}
						/>
					{:else if step.kind === 'script'}
						<ScriptStepRow
							step={step as NavScriptStep}
							index={i}
							collapseKey={`${tabId}::${pathKey(path)}::step:${i}`}
							onChange={setStep}
							onRemove={removeStep}
						/>
					{:else if step.kind === 'filter'}
						<FilterStepRow
							step={step as NavFilterStep}
							index={i}
							propertyNames={propertyNamesFor(i)}
							onChange={setStep}
							onRemove={removeStep}
						/>
					{/if}
				</div>
			{/each}
		</div>

		{#if editable}
			<div class="flex items-center gap-2 pl-7">
				<!-- A scalar property step is a legitimate TERMINAL (the chain ends at
				     the value); the per-step "navigation ends here" notice is the only
				     message — this area simply hides the add-step buttons. -->
				{#if blockedAt === null}
					<button
						type="button"
						class="rounded border border-dashed border-input px-2 py-1 text-info/90 transition-colors hover:border-ring hover:text-info"
						onclick={addRelationshipStep}
					>
						+ Follow a relationship
					</button>
					<button
						type="button"
						class="rounded border border-dashed border-input px-2 py-1 text-info/90 transition-colors hover:border-ring hover:text-info"
						onclick={addFilterStep}
					>
						+ Keep only…
					</button>
					<button
						type="button"
						class="rounded border border-dashed border-input px-2 py-1 text-info/90 transition-colors hover:border-ring hover:text-info"
						onclick={addPropertyStep}
					>
						+ Go to property…
					</button>
					<button
						type="button"
						data-testid="add-script-step"
						class="rounded border border-dashed border-input px-2 py-1 text-info/90 transition-colors hover:border-ring hover:text-info"
						onclick={addScriptStep}
					>
						+ Script step
					</button>
				{/if}
			</div>
		{/if}

		{#if editable}
			<div class="flex items-center gap-3 border-t border-border pt-2">
				<DropdownMenu.Root>
					<DropdownMenu.Trigger class="text-info/90 transition-colors hover:text-info">
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
			<summary
				class="cursor-pointer text-muted-foreground/70 select-none transition-colors hover:text-muted-foreground"
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
	{/if}
</div>
