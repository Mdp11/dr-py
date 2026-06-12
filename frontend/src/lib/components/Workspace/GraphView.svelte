<script lang="ts">
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';
	import { SvelteFlow, Background, Controls, type Node, type Edge } from '@xyflow/svelte';
	import '@xyflow/svelte/dist/style.css';
	import { AlertTriangle } from '@lucide/svelte';

	import {
		getIssues,
		getMetamodel,
		getModelGeneration,
		getModelRev,
		getModelSummary,
		getSelection,
		indexIssues,
		isTempId,
		seedElements,
		seedRelationships,
		select
	} from '$lib/state';
	import { getNeighborhood } from '$lib/api/model-read';
	import { NotFoundError } from '$lib/api/errors';
	import type { Neighborhood } from '$lib/api/types';
	import { containmentRelTypes } from '$lib/metamodel/helpers';

	let maxHops = $state(2);
	let nodeCap = $state(60);

	const HOP_OPTIONS = [1, 2, 3, 4];

	const selection = $derived(getSelection());
	const metamodel = $derived(getMetamodel());
	const summary = $derived(getModelSummary());

	const centerId = $derived.by((): string | null => {
		if (selection === null || selection.kind !== 'element') return null;
		return selection.id;
	});

	// Server-side BFS (GET /model/elements/{id}/neighborhood). Refresh policy:
	// refetch whenever the center / hops / cap change AND on every acked ops
	// batch (model_rev bump) while an element is selected — optimistic local
	// edits appear once the flush (0 ms for structural ops) is acknowledged.
	// An unflushed temp-id center is served from nothing (the server doesn't
	// know it yet); the next rev bump re-points the selection and refetches.
	let neighborhood: Neighborhood | null = $state(null);
	let centerMissing = $state(false);
	let fetchSeq = 0;

	$effect(() => {
		const id = centerId;
		const hops = maxHops;
		const cap = nodeCap;
		void getModelRev();
		void getModelGeneration(); // model swap with an equal rev still refetches
		const seq = ++fetchSeq;
		if (id === null || isTempId(id)) {
			neighborhood = null;
			centerMissing = false;
			return;
		}
		void (async () => {
			try {
				const n = await getNeighborhood(id, { hops, cap });
				if (seq !== fetchSeq) return;
				seedElements(n.nodes);
				seedRelationships(n.edges);
				neighborhood = n;
				centerMissing = false;
			} catch (err) {
				if (seq !== fetchSeq) return;
				neighborhood = null;
				centerMissing = err instanceof NotFoundError;
				if (!(err instanceof NotFoundError)) {
					console.error('Neighborhood fetch failed', err);
				}
			}
		})();
	});

	const containmentNames = $derived.by(() => {
		if (metamodel === null) return new SvelteSet<string>();
		return new SvelteSet(containmentRelTypes(metamodel).map((rt) => rt.name));
	});

	type GraphNode = { id: string; type_name: string; label: string; hops: number };

	function labelFor(el: { id: string; properties: Record<string, unknown> }): string {
		const n = el.properties?.name;
		if (typeof n === 'string' && n.length > 0) return n;
		if (el.id.length <= 8) return el.id;
		return el.id.slice(0, 8) + '…';
	}

	const graphNodes = $derived.by((): GraphNode[] => {
		if (neighborhood === null) return [];
		return neighborhood.nodes.map((el) => ({
			id: el.id,
			type_name: el.type_name,
			label: labelFor(el),
			hops: neighborhood?.hops_by_id[el.id] ?? 0
		}));
	});

	const truncated = $derived.by(() => neighborhood?.truncated ?? false);

	const centerLabel = $derived.by((): string => {
		const c = graphNodes.find((n) => n.hops === 0);
		return c?.label ?? centerId ?? '';
	});

	// Simple radial layout: hop 0 at origin, hop h placed on a ring of radius
	// 200*h with equal angular spacing among siblings at that hop.
	function radialLayout(nodes: GraphNode[]): Map<string, { x: number; y: number }> {
		const byHop = new SvelteMap<number, GraphNode[]>();
		for (const n of nodes) {
			const arr = byHop.get(n.hops) ?? [];
			arr.push(n);
			byHop.set(n.hops, arr);
		}
		const positions = new SvelteMap<string, { x: number; y: number }>();
		for (const [hop, group] of byHop) {
			if (hop === 0) {
				for (const n of group) positions.set(n.id, { x: 0, y: 0 });
				continue;
			}
			const radius = 200 * hop;
			const count = group.length;
			group.forEach((n, idx) => {
				const angle = (2 * Math.PI * idx) / count;
				positions.set(n.id, {
					x: radius * Math.cos(angle),
					y: radius * Math.sin(angle)
				});
			});
		}
		return positions;
	}

	const issueIndex = $derived(indexIssues(getIssues()));

	function nodeStyle(n: GraphNode): string {
		const isCenter = n.hops === 0;
		const hasError = issueIndex.errorIds.has(n.id);
		const hasWarning = !hasError && issueIndex.warningIds.has(n.id);
		const bg = isCenter ? '#1e293b' : '#18181b';
		const color = isCenter ? '#f1f5f9' : '#e4e4e7';
		let border = isCenter ? '#818cf8' : '#3f3f46';
		let borderWidth = '1px';
		if (hasError) {
			border = '#f87171';
			borderWidth = '2px';
		} else if (hasWarning) {
			border = '#fbbf24';
			borderWidth = '2px';
		}
		const ring = isCenter ? ' box-shadow: 0 0 0 2px rgba(129,140,248,0.35) inset;' : '';
		return `background:${bg}; color:${color}; border:${borderWidth} solid ${border}; border-radius:6px; padding:6px 10px; font-size:11px;${ring}`;
	}

	const flowNodes: Node[] = $derived.by(() => {
		const positions = radialLayout(graphNodes);
		return graphNodes.map((n) => ({
			id: n.id,
			type: 'default',
			data: { label: n.label, type_name: n.type_name, hops: n.hops },
			position: positions.get(n.id) ?? { x: 0, y: 0 },
			style: nodeStyle(n)
		}));
	});

	const flowEdges: Edge[] = $derived.by(() =>
		(neighborhood?.edges ?? []).map((e) => ({
			id: e.id,
			source: e.source_id,
			target: e.target_id,
			type: 'default',
			label: e.type_name,
			labelStyle: 'fill:#a1a1aa; font-size:10px;',
			labelBgStyle: 'fill:#09090b;',
			data: { containment: containmentNames.has(e.type_name) },
			style: containmentNames.has(e.type_name)
				? 'stroke:#a5b4fc; stroke-width:2px;'
				: 'stroke:#71717a;',
			markerEnd: {
				type: 'arrowclosed',
				color: containmentNames.has(e.type_name) ? '#a5b4fc' : '#71717a'
			} as unknown as Edge['markerEnd']
		}))
	);

	const totalElements = $derived(summary?.element_count ?? 0);

	function handleNodeClick({ node }: { node: Node }): void {
		select({ kind: 'element', id: node.id });
	}
</script>

<div class="flex h-full w-full flex-col bg-zinc-950">
	<div class="flex items-center gap-3 border-b border-zinc-800 px-3 py-2 text-xs text-zinc-300">
		<div class="flex items-center gap-1">
			<span class="text-zinc-500">Hops:</span>
			<div class="flex items-center gap-0.5 rounded border border-zinc-800 bg-zinc-900 p-0.5">
				{#each HOP_OPTIONS as h (h)}
					<button
						type="button"
						class="rounded px-2 py-0.5 text-[11px] {maxHops === h
							? 'bg-indigo-500/30 text-indigo-100'
							: 'text-zinc-400 hover:text-zinc-200'}"
						onclick={() => (maxHops = h)}
					>
						{h}
					</button>
				{/each}
			</div>
		</div>

		{#if centerId !== null}
			<div class="flex items-center gap-1">
				<span class="text-zinc-500">Center:</span>
				<span class="rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-[11px] text-zinc-100">
					{centerLabel}
				</span>
			</div>

			<div class="ml-auto flex items-center gap-2">
				<span class="text-zinc-500">
					Showing {graphNodes.length} of {totalElements} elements
				</span>
				{#if truncated}
					<span
						class="flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-300"
						title="Some neighbors were dropped because the node cap was reached. Increase nodeCap or reduce hops."
					>
						<AlertTriangle class="h-3 w-3" />
						truncated
					</span>
				{/if}
			</div>
		{/if}
	</div>

	<div class="relative flex-1">
		{#if centerId === null}
			<div class="flex h-full items-center justify-center px-4 text-center text-xs text-zinc-500">
				Select an element from the tree or search to see its neighborhood.
			</div>
		{:else if graphNodes.length === 0}
			<div class="flex h-full items-center justify-center px-4 text-center text-xs text-zinc-500">
				{centerMissing
					? 'Selection no longer exists in the working model.'
					: 'Loading neighborhood…'}
			</div>
		{:else}
			<SvelteFlow
				nodes={flowNodes}
				edges={flowEdges}
				fitView
				colorMode="dark"
				nodesDraggable={false}
				nodesConnectable={false}
				elementsSelectable
				panOnDrag
				onnodeclick={handleNodeClick}
				style="background:#09090b;"
			>
				<Background />
				<Controls />
			</SvelteFlow>
		{/if}
	</div>
</div>
