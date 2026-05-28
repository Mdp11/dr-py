<script lang="ts">
	import type { Element } from '$lib/api/types';
	import { containmentRelTypes } from '$lib/metamodel/helpers';
	import {
		getMetamodel,
		getSelection,
		getTypeFilter,
		getWorkingModel,
		select
	} from '$lib/state';
	import TreeNode from './TreeNode.svelte';

	const mm = $derived(getMetamodel());
	const working = $derived(getWorkingModel());
	const typeFilter = $derived(getTypeFilter());

	let collapsed: Set<string> = $state(new Set());

	function toggleCollapsed(id: string): void {
		const next = new Set(collapsed);
		if (next.has(id)) next.delete(id);
		else next.add(id);
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
	// descendant (via containment) does. Empty filter => keep everything.
	function buildKeepSet(): Set<string> {
		const keep = new Set<string>();
		if (typeFilter.size === 0) {
			for (const el of working.elements) keep.add(el.id);
			return keep;
		}
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
</script>

<section class="flex min-h-0 flex-1 flex-col gap-1 overflow-auto px-3 py-2">
	<h2 class="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Tree</h2>
	{#if mm === null}
		<p class="text-xs text-zinc-600">Load a metamodel and model to begin.</p>
	{:else if working.elements.length === 0}
		<p class="text-xs text-zinc-600">Model is empty.</p>
	{:else}
		<ul class="flex flex-col text-xs">
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
						onToggle={toggleCollapsed}
						onPick={onPick}
					/>
				{/if}
			{/each}
		</ul>
	{/if}
</section>
