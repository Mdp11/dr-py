<script lang="ts">
	import type { Element } from '$lib/api/types';
	import { containmentRelTypes } from '$lib/metamodel/helpers';
	import {
		createTempId,
		emit,
		ensureTypeFilterInitialized,
		getMetamodel,
		getSelection,
		getTypeFilter,
		getWorkingModel,
		select,
		setTypeFilter,
		toggleType
	} from '$lib/state';
	import { Filter, Plus } from '@lucide/svelte';
	import StereotypePicker from './StereotypePicker.svelte';
	import TreeNode from './TreeNode.svelte';

	const mm = $derived(getMetamodel());
	const working = $derived(getWorkingModel());
	const typeFilter = $derived(getTypeFilter());

	// Concrete (non-abstract) element types — the only ones that can be
	// instantiated or that ever appear as `el.type_name` in the model.
	const concreteTypeNames = $derived.by<string[]>(() => {
		if (mm === null) return [];
		return mm.elements.filter((e) => !e.abstract).map((e) => e.name);
	});

	$effect(() => {
		if (mm !== null) ensureTypeFilterInitialized(concreteTypeNames);
	});

	let filterOpen = $state(false);
	let createOpen = $state(false);

	function onSelectAll(): void {
		setTypeFilter(new Set(concreteTypeNames));
	}

	function onDeselectAll(): void {
		setTypeFilter(new Set());
	}

	function onCreateElement(typeName: string): void {
		const tempId = createTempId();
		emit({
			kind: 'create_element',
			temp_id: tempId,
			type_name: typeName,
			properties: {}
		});
		select({ kind: 'element', id: tempId });
	}

	let collapsed: Set<string> = $state(new Set());

	function toggleCollapsed(id: string): void {
		const next = new Set(collapsed);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		collapsed = next;
	}

	function setCollapsed(id: string, value: boolean): void {
		if (collapsed.has(id) === value) return;
		const next = new Set(collapsed);
		if (value) next.add(id);
		else next.delete(id);
		collapsed = next;
	}

	const elementsById = $derived.by(() => {
		const m = new Map<string, Element>();
		for (const el of working.elements) m.set(el.id, el);
		return m;
	});

	const containmentRelTypeNames = $derived.by(() => {
		if (mm === null) return new Set<string>();
		return new Set(containmentRelTypes(mm).map((r) => r.name));
	});

	// childrenByParent: source -> [target,...] (source contains target).
	const childrenByParent = $derived.by(() => {
		const m = new Map<string, string[]>();
		const containedIds = new Set<string>();
		for (const rel of working.relationships) {
			if (!containmentRelTypeNames.has(rel.type_name)) continue;
			if (!elementsById.has(rel.source_id) || !elementsById.has(rel.target_id)) continue;
			if (containedIds.has(rel.target_id)) continue; // first containment parent wins
			containedIds.add(rel.target_id);
			const arr = m.get(rel.source_id);
			if (arr) arr.push(rel.target_id);
			else m.set(rel.source_id, [rel.target_id]);
		}
		// Stable ordering by display name within each parent.
		for (const [k, ids] of m) {
			ids.sort((a, b) => displayName(elementsById.get(a)!).localeCompare(displayName(elementsById.get(b)!)));
			m.set(k, ids);
		}
		return { childrenByParent: m, containedIds };
	});

	const roots = $derived.by(() => {
		const { containedIds } = childrenByParent;
		const rs: string[] = [];
		for (const el of working.elements) {
			if (!containedIds.has(el.id)) rs.push(el.id);
		}
		rs.sort((a, b) => displayName(elementsById.get(a)!).localeCompare(displayName(elementsById.get(b)!)));
		return rs;
	});

	function displayName(el: Element): string {
		const n = el.properties?.name;
		return typeof n === 'string' && n.length > 0 ? n : el.id;
	}

	// `keep(id)` is true if the element passes the type filter directly OR any
	// descendant (via containment) does. The filter is a strict allowlist:
	// an empty set hides all elements.
	function buildKeepSet(): Set<string> {
		const keep = new Set<string>();
		const { childrenByParent: kids } = childrenByParent;
		const visit = (id: string): boolean => {
			if (keep.has(id)) return true;
			const el = elementsById.get(id);
			let self = false;
			if (el && typeFilter.has(el.type_name)) self = true;
			let descendant = false;
			const cs = kids.get(id) ?? [];
			for (const c of cs) {
				if (visit(c)) descendant = true;
			}
			if (self || descendant) {
				keep.add(id);
				return true;
			}
			return false;
		};
		for (const r of roots) visit(r);
		return keep;
	}

	const keepSet = $derived.by(() => buildKeepSet());

	const selection = $derived(getSelection());

	function onPick(id: string): void {
		select({ kind: 'element', id });
	}

	// ----- keyboard navigation -----

	// Build a flattened list of currently visible rows (id + parent id) in DOM order.
	type VisibleRow = { id: string; parent: string | null };
	const visibleRows = $derived.by<VisibleRow[]>(() => {
		const out: VisibleRow[] = [];
		const { childrenByParent: kids } = childrenByParent;
		const walk = (id: string, parent: string | null): void => {
			if (!keepSet.has(id)) return;
			out.push({ id, parent });
			if (collapsed.has(id)) return;
			const cs = kids.get(id) ?? [];
			for (const c of cs) walk(c, id);
		};
		for (const r of roots) walk(r, null);
		return out;
	});

	let focusedId: string | null = $state(null);

	const focusedIndex = $derived.by(() => {
		if (focusedId === null) return -1;
		return visibleRows.findIndex((r) => r.id === focusedId);
	});

	function moveTo(idx: number): void {
		if (idx < 0 || idx >= visibleRows.length) return;
		focusedId = visibleRows[idx].id;
	}

	function onKeyDown(e: KeyboardEvent): void {
		if (visibleRows.length === 0) return;
		const cur = focusedIndex;
		const k = e.key;
		if (k === 'ArrowDown') {
			e.preventDefault();
			if (cur < 0) moveTo(0);
			else moveTo(Math.min(visibleRows.length - 1, cur + 1));
		} else if (k === 'ArrowUp') {
			e.preventDefault();
			if (cur < 0) moveTo(visibleRows.length - 1);
			else moveTo(Math.max(0, cur - 1));
		} else if (k === 'ArrowRight') {
			if (cur < 0) return;
			e.preventDefault();
			const row = visibleRows[cur];
			const kids = childrenByParent.childrenByParent.get(row.id) ?? [];
			const hasChildren = kids.some((c) => keepSet.has(c));
			if (hasChildren && collapsed.has(row.id)) {
				setCollapsed(row.id, false);
			} else if (hasChildren) {
				// Already expanded — jump to first visible child.
				moveTo(cur + 1);
			}
		} else if (k === 'ArrowLeft') {
			if (cur < 0) return;
			e.preventDefault();
			const row = visibleRows[cur];
			const kids = childrenByParent.childrenByParent.get(row.id) ?? [];
			const hasChildren = kids.some((c) => keepSet.has(c));
			if (hasChildren && !collapsed.has(row.id)) {
				setCollapsed(row.id, true);
			} else if (row.parent !== null) {
				const pIdx = visibleRows.findIndex((r) => r.id === row.parent);
				if (pIdx >= 0) moveTo(pIdx);
			}
		} else if (k === 'Enter' || k === ' ') {
			if (cur < 0) return;
			e.preventDefault();
			select({ kind: 'element', id: visibleRows[cur].id });
		}
	}

	// Sync focused-row from the global selection when it changes externally.
	$effect(() => {
		if (selection?.kind === 'element' && visibleRows.some((r) => r.id === selection.id)) {
			focusedId = selection.id;
		}
	});
</script>

<div class="flex min-h-0 flex-1 flex-col">
	<div class="flex items-center justify-between gap-2 px-3 pt-2">
		<h2 class="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Tree</h2>
		{#if mm !== null}
			<div class="flex items-center gap-0.5">
				<StereotypePicker
					mode="filter"
					names={concreteTypeNames}
					checked={typeFilter}
					onToggle={toggleType}
					onSelectAll={onSelectAll}
					onDeselectAll={onDeselectAll}
					open={filterOpen}
					onOpenChange={(v) => (filterOpen = v)}
					searchPlaceholder="Filter stereotypes…"
					emptyLabel="No stereotypes."
				>
					{#snippet trigger()}
						<span
							class="inline-flex h-5 w-5 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
							aria-label="Filter stereotypes"
							title="Filter stereotypes"
						>
							<Filter class="h-3 w-3" />
						</span>
					{/snippet}
				</StereotypePicker>
				<StereotypePicker
					mode="create"
					names={concreteTypeNames}
					onPick={onCreateElement}
					open={createOpen}
					onOpenChange={(v) => (createOpen = v)}
					searchPlaceholder="Search stereotypes…"
					emptyLabel="No stereotypes."
				>
					{#snippet trigger()}
						<span
							class="inline-flex h-5 w-5 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
							aria-label="New element"
							title="New element"
						>
							<Plus class="h-3 w-3" />
						</span>
					{/snippet}
				</StereotypePicker>
			</div>
		{/if}
	</div>
	<div
		class="flex min-h-0 flex-1 flex-col gap-1 overflow-auto px-3 py-2 outline-none focus:ring-2 focus:ring-inset focus:ring-indigo-500"
		tabindex="0"
		role="tree"
		aria-label="Containment tree"
		onkeydown={onKeyDown}
	>
	{#if mm === null}
		<p class="text-xs text-zinc-600">Load a metamodel and model to begin.</p>
	{:else if working.elements.length === 0}
		<p class="text-xs text-zinc-600">Model is empty.</p>
	{:else}
		<ul class="flex flex-col text-xs" role="group">
			{#each roots as rootId (rootId)}
				{#if keepSet.has(rootId)}
					<TreeNode
						id={rootId}
						depth={0}
						{elementsById}
						childrenByParent={childrenByParent.childrenByParent}
						{keepSet}
						{collapsed}
						selectedId={selection?.kind === 'element' ? selection.id : null}
						{focusedId}
						onToggle={toggleCollapsed}
						onPick={onPick}
					/>
				{/if}
			{/each}
		</ul>
	{/if}
	</div>
</div>
