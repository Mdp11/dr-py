<script lang="ts">
	import {
		SvelteFlow,
		Background,
		Controls,
		type Node,
		type Edge
	} from '@xyflow/svelte';
	import '@xyflow/svelte/dist/style.css';
	import { AlertTriangle } from '@lucide/svelte';

	import {
		getIssues,
		getMetamodel,
		getSelection,
		getWorkingModel,
		indexIssues,
		select
	} from '$lib/state';
	import { buildGraph, type GraphData, type GraphNode } from './graph-data';

	let maxHops = $state(2);
	let nodeCap = $state(60);

	const HOP_OPTIONS = [1, 2, 3, 4];

	const selection = $derived(getSelection());
	const working = $derived(getWorkingModel());
	const metamodel = $derived(getMetamodel());

	const centerId = $derived.by((): string | null => {
		if (selection === null || selection.kind !== 'element') return null;
		return selection.id;
	});

	const data: GraphData = $derived.by(() => {
		if (centerId === null || metamodel === null) {
			return { nodes: [], edges: [], truncated: false };
		}
		return buildGraph({
			metamodel,
			working,
			centerId,
			maxHops,
			nodeCap
		});
	});

	const centerElement = $derived.by(() => {
		if (centerId === null) return null;
		return working.elements.find((e) => e.id === centerId) ?? null;
	});

	const centerLabel = $derived.by((): string => {
		const c = centerElement;
		if (!c) return '';
		const n = c.properties?.name;
		if (typeof n === 'string' && n.length > 0) return n;
		return c.id;
	});

	// Simple radial layout: hop 0 at origin, hop h placed on a ring of radius
	// 200*h with equal angular spacing among siblings at that hop.
	function radialLayout(nodes: GraphNode[]): Map<string, { x: number; y: number }> {
		const byHop = new Map<number, GraphNode[]>();
		for (const n of nodes) {
			const arr = byHop.get(n.hops) ?? [];
			arr.push(n);
			byHop.set(n.hops, arr);
		}
		const positions = new Map<string, { x: number; y: number }>();
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
		const ring = isCenter
			? ' box-shadow: 0 0 0 2px rgba(129,140,248,0.35) inset;'
			: '';
		return `background:${bg}; color:${color}; border:${borderWidth} solid ${border}; border-radius:6px; padding:6px 10px; font-size:11px;${ring}`;
	}

	const flowNodes: Node[] = $derived.by(() => {
		const positions = radialLayout(data.nodes);
		return data.nodes.map((n) => ({
			id: n.id,
			type: 'default',
			data: { label: n.label, type_name: n.type_name, hops: n.hops },
			position: positions.get(n.id) ?? { x: 0, y: 0 },
			style: nodeStyle(n)
		}));
	});

	const flowEdges: Edge[] = $derived.by(() =>
		data.edges.map((e) => ({
			id: e.id,
			source: e.source,
			target: e.target,
			type: 'default',
			label: e.type_name,
			labelStyle: 'fill:#a1a1aa; font-size:10px;',
			labelBgStyle: 'fill:#09090b;',
			data: { containment: e.containment },
			style: e.containment
				? 'stroke:#a5b4fc; stroke-width:2px;'
				: 'stroke:#71717a;',
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			markerEnd: {
				type: 'arrowclosed',
				color: e.containment ? '#a5b4fc' : '#71717a'
			} as unknown as Edge['markerEnd']
		}))
	);

	const totalElements = $derived(working.elements.length);

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
					Showing {data.nodes.length} of {totalElements} elements
				</span>
				{#if data.truncated}
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
		{:else if data.nodes.length === 0}
			<div class="flex h-full items-center justify-center px-4 text-center text-xs text-zinc-500">
				Selection no longer exists in the working model.
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
