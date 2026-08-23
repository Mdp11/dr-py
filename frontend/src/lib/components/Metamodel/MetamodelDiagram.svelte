<script lang="ts">
	import { SvelteFlow, useSvelteFlow, type Edge, type Node } from '@xyflow/svelte';
	import '@xyflow/svelte/dist/style.css';

	import { Button } from '$lib/components/ui/button';
	import { buildAdjacency } from '$lib/metamodel/diagram-adjacency';
	import {
		buildDiagram,
		nodeIdFor,
		nodeSize,
		selectionForNodeId,
		type DiagramNodeSpec
	} from '$lib/metamodel/diagram-build';
	import { datatypeNamespace, uniqueTypeName } from '$lib/metamodel/helpers';
	import {
		LOD_TOOLTIP_MAX_W,
		lodTooltipAnchor,
		tooltipStyle
	} from '$lib/metamodel/diagram-tooltip';
	import {
		applyDiagramEdit,
		getDiagramHoverLabel,
		getHoverCursor,
		getLodActive,
		getMetamodelDiagramView,
		getMetamodelEditor,
		getMetamodelPanel,
		getRole,
		moveNode,
		noteHoverCursor,
		noteZoom,
		resetMetamodelCanvas,
		runAutoArrange,
		selectDiagramNode,
		setAllCollapsed,
		setDiagramAdjacency,
		setDiagramHover,
		setMetamodelPanelCollapsed,
		setMetamodelView,
		toggleNodeCollapsed,
		undoDiagramEdit
	} from '$lib/state';
	import { ChevronsLeft, ChevronsRight } from '@lucide/svelte';

	import MetamodelFormPanel from './forms/MetamodelFormPanel.svelte';
	import MetamodelSearch from './MetamodelSearch.svelte';

	import AssocClassNode from './diagram/AssocClassNode.svelte';
	import AssociationEdge from './diagram/AssociationEdge.svelte';
	import ConnectionPopover from './diagram/ConnectionPopover.svelte';
	import ElementTypeNode from './diagram/ElementTypeNode.svelte';
	import EnumTypeNode from './diagram/EnumTypeNode.svelte';
	import GeneralizationEdge from './diagram/GeneralizationEdge.svelte';

	/**
	 * The DIAGRAM surface of the metamodel tab: a UML class diagram over the same
	 * YAML draft the editor half edits. Every gesture here goes through
	 * `state/metamodel-diagram.svelte.ts`, which turns it into a buffer edit —
	 * this component owns rendering and nothing else.
	 *
	 * **Two independent gates, deliberately.** `readOnly` comes from the editor
	 * module (owner-only, plus a peer's lease) and hides
	 * every affordance that would CHANGE THE DRAFT. Dragging is gated separately
	 * on `getRole() !== 'viewer'`, because node positions are presentation: a
	 * drag stages a `metamodel.move_node` op rather than editing the draft, so
	 * an editor may rearrange the picture without being able to edit the
	 * metamodel (a viewer's drags stay local and stage nothing).
	 * Viewers pan, zoom, select and collapse — a read-only canvas, not a picture.
	 *
	 * What the ROLE split does NOT extend to is the lease: a staged move needs
	 * the same singleton `mm` lease a rebind does (the backend verifies it for
	 * the whole `metamodel.*` family), so the state module acquires it on the
	 * first drag — for an editor as much as an owner. A drag while a PEER holds
	 * it stays local and stages nothing, and the `lockedBy` note below is how
	 * that surfaces.
	 *
	 * **`useSvelteFlow()` needs a provider ABOVE this component** (a hook binds
	 * context at ITS call site, so a `<SvelteFlowProvider>` rendered here would
	 * be too late). `MetamodelTab` supplies it — that is why the toolbar can
	 * drive Fit view and the search pan from outside `<SvelteFlow>`.
	 *
	 * The canvas is only half the surface: `MetamodelFormPanel` docks to its
	 * right and owns everything a box cannot show, and `ConnectionPopover`
	 * mounts over it to ask what a dragged connection meant.
	 */

	const view = $derived(getMetamodelDiagramView());
	const panel = $derived(getMetamodelPanel());
	const ed = $derived(getMetamodelEditor());
	/** Draft edits: owner-only, via the editor module's own gate. */
	const readOnly = $derived(ed.readOnly);
	/** Layout: everyone but a viewer (see the module note above). */
	const canDragLayout = $derived(getRole() !== 'viewer');

	/**
	 * The lint surface. `errorNodeIds` is empty in every reachable state — the
	 * server attaches a `line` only to a YAML *syntax* error, which also fails
	 * the local parse, which means nothing is drawn to badge (the state module's
	 * `attributeLintErrors` documents this in full) — so the COUNT, not a
	 * per-node marker, is what guarantees an error is never silently dropped.
	 * The set is still added in rather than ignored: if attribution ever starts
	 * producing hits, a badged node must not also vanish from this total.
	 */
	const issueCount = $derived(view.unattributedErrorCount + view.errorNodeIds.size);

	/**
	 * Why the editing affordances are missing, in the split this surface
	 * actually has: a peer's lease is temporary and names its cause (and takes
	 * the layout half with it — the staged move needs that same lease, so under
	 * a peer's hold a drag is local and nothing is proposed), an EDITOR keeps
	 * the layout half (positions are presentation, so they are committable
	 * without the OWNER role — the `mm` lease is still acquired for them), and a
	 * VIEWER keeps neither. Without this the toolbar just quietly loses its
	 * buttons.
	 *
	 * There is no "Rebinding — editing is paused" case: a rebind is an op in
	 * the commit batch rather than a flight this surface has to freeze for.
	 */
	const readOnlyNote = $derived.by((): string | null => {
		if (!readOnly) return null;
		if (ed.lockedBy !== null) return `Locked by ${ed.lockedBy} — browsing only.`;
		if (!canDragLayout) return 'Read-only — layout changes are not saved.';
		return 'Metamodel edits are owner-only — you can still rearrange the layout.';
	});

	/** The mockup's canvas ground: the app background under one ambient jade
	 * radial glow at 25%/15%, and NO dot grid — xyflow's `<Background />` is
	 * deliberately not mounted, because the approved design has bare ground and
	 * a grid competes with the hairline boxes it is meant to sit behind. The
	 * `7%` is the mockup's own alpha on `--ring`, which is the token its
	 * `oklch(0.74 0.06 155)` literal came from. It rides the flow's own wrapper,
	 * so it stays put while the diagram pans under it. */
	const CANVAS_GROUND =
		'background: radial-gradient(ellipse at 25% 15%, color-mix(in oklab, var(--ring) 7%, transparent), transparent 55%), var(--background);';

	const nodeTypes = {
		elementType: ElementTypeNode,
		enumType: EnumTypeNode,
		assocClass: AssocClassNode
	};
	const edgeTypes = { generalization: GeneralizationEdge, association: AssociationEdge };

	/**
	 * The parsed metamodel, hoisted into its OWN `$derived` — the one thing
	 * standing between a canvas click and an O(metamodel) rebuild.
	 *
	 * `getMetamodelDiagramView()` returns a fresh object literal on every
	 * recompute, and it recomputes whenever selection, collapse, undo depth,
	 * positions or the buffer change. So `buildDiagram(view.mm)` written inline
	 * would re-run on all of those. The state module memoizes the parse by
	 * buffer identity, which makes `view.mm` referentially STABLE across every
	 * change that isn't a buffer edit; reading it through a derived of its own
	 * lets Svelte's equality check find the value unchanged and leave `built`
	 * — and everything downstream of it — alone. At ~300 types that is the
	 * difference between a click costing a full rebuild and costing nothing.
	 */
	const parsedMm = $derived(view.mm);
	const built = $derived(parsedMm === null ? { nodes: [], edges: [] } : buildDiagram(parsedMm));
	const selectedNodeId = $derived(view.selection === null ? null : nodeIdFor(view.selection));

	// The adjacency the hover store needs: rebuilt only when the parsed
	// metamodel changes — `built` hangs off `parsedMm` above, so a selection, a
	// collapse or a drag leaves it alone — and NEVER on hover, since hover
	// state is written into `metamodel-canvas.svelte.ts` and read back only
	// inside the node/edge components, never by anything on this line. The
	// cleanup keeps a closed canvas from leaving stale hover state behind for
	// the next mount.
	$effect(() => {
		setDiagramAdjacency(buildAdjacency(built.edges));
	});
	$effect(() => {
		return () => resetMetamodelCanvas();
	});

	const lodActive = $derived(getLodActive());
	const lodTooltip = $derived(lodActive ? getDiagramHoverLabel() : null);
	const hoverCursor = $derived(getHoverCursor());

	function specToNode(spec: DiagramNodeSpec): Node {
		const collapsed = view.collapsed.has(spec.id);
		return {
			id: spec.id,
			type: spec.type,
			position: view.positions[spec.id] ?? { x: 0, y: 0 },
			data: {
				...spec.data,
				collapsed,
				// Always empty in practice (see MetamodelDiagramView.errorNodeIds);
				// the node just styles it, based on error state owned elsewhere.
				hasError: view.errorNodeIds.has(spec.id),
				onToggleCollapse: toggleNodeCollapsed
			},
			selected: spec.id === selectedNodeId,
			draggable: canDragLayout,
			// The ONE place a box's footprint is decided is `nodeSize`, which elk
			// also lays out against — so the drawn width can never disagree with
			// the space reserved for it.
			style: `width: ${nodeSize(spec, collapsed).width}px;`
		};
	}

	// `nodes`/`edges` are bindable: Svelte Flow writes drag positions and measured
	// dimensions back through them. The effect below is the one-way half —
	// authoritative state (positions, collapse, selection, the parsed metamodel)
	// rebuilds them; nothing here reads the bound values back, so there is no loop.
	let flowNodes = $state.raw<Node[]>([]);
	let flowEdges = $state.raw<Edge[]>([]);

	$effect(() => {
		flowNodes = built.nodes.map(specToNode);
	});

	/** Relationship types whose edges must read as CONTAINMENT.
	 *
	 * `buildDiagram` puts `containment` on the half that carries the diamond —
	 * the `assoc-in` (owner → box) half — and not on the `assoc-out` half, which
	 * is correct for the MARKER (a composition diamond belongs at the whole end,
	 * once) but would leave one relationship drawn in two colours. So the
	 * STYLING is propagated per relationship name here, at render time, while
	 * `data.containment` keeps owning the marker. Doing it here rather than in
	 * `diagram-build.ts` keeps the shipped data shape (and its tests) untouched:
	 * this is a presentation rule, and the canvas is where presentation lives. */
	const containmentRels = $derived(
		new Set(
			built.edges
				.filter((e) => e.data.containment === true)
				.map((e) => e.data.relName)
				.filter((name): name is string => name !== undefined)
		)
	);

	$effect(() => {
		// A selected relationship highlights ALL of its edges: a mapping list, or
		// an association class's two tether halves, is one relationship type in
		// the YAML and has to read as one thing on the canvas.
		const relName =
			view.selection !== null && view.selection.kind === 'relationship'
				? view.selection.name
				: null;
		flowEdges = built.edges.map((e) => ({
			id: e.id,
			source: e.source,
			target: e.target,
			type: e.type,
			data: {
				...e.data,
				containmentRel: e.data.relName !== undefined && containmentRels.has(e.data.relName)
			},
			selected: relName !== null && e.data.relName === relName
		}));
	});

	const flow = useSvelteFlow();

	// --- toolbar ---------------------------------------------------------------

	// Both create buttons pick a name free across the WHOLE datatype space
	// (element types + enums + primitives), not just their own section: a
	// created name that collides is the create-side twin of the rename guard —
	// `addElementType` would append a second same-named block that every later
	// lookup resolves first-wins past, and `addEnum` would silently OVERWRITE
	// the existing enum's literals (`yaml-edit`'s enums are a YAML mapping).
	function createElementType(): void {
		if (view.mm === null) return;
		const name = uniqueTypeName('NewType', datatypeNamespace(view.mm));
		// Select on success so the form panel opens on the new type instead of
		// leaving the user to hunt for the box that just appeared.
		if (applyDiagramEdit({ kind: 'addElementType', name })) {
			selectDiagramNode({ kind: 'element', name });
		}
	}

	function createEnum(): void {
		if (view.mm === null) return;
		const name = uniqueTypeName('NewEnum', datatypeNamespace(view.mm));
		if (applyDiagramEdit({ kind: 'addEnum', name, literals: [] })) {
			selectDiagramNode({ kind: 'enum', name });
		}
	}

	// --- connections -----------------------------------------------------------

	/** The element-type pair a completed drag proposed, awaiting the popover's
	 * answer. Names, not node ids: everything downstream speaks metamodel. */
	let pendingConnection = $state<{ source: string; target: string } | null>(null);

	/**
	 * `onbeforeconnect`, deliberately, NOT `onconnect`: Svelte Flow's handle
	 * calls this first and skips `store.addEdge` entirely when it returns
	 * false. Every edge on this canvas is DERIVED from the YAML, so an edge the
	 * flow adds on its own is a lie the user cannot undo — it would survive a
	 * cancelled popover and disappear only on the next unrelated rebuild.
	 *
	 * A connection whose ends are not both element types (a drag onto an
	 * association-class box) is refused the same way, with no popover: none of
	 * the three answers below has a meaning for it.
	 */
	function onBeforeConnect(connection: { source: string; target: string }): false {
		const from = selectionForNodeId(connection.source);
		const to = selectionForNodeId(connection.target);
		if (!readOnly && from?.kind === 'element' && to?.kind === 'element') {
			pendingConnection = { source: from.name, target: to.name };
		}
		return false;
	}

	function onKeydown(e: KeyboardEvent): void {
		if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
			e.preventDefault();
			undoDiagramEdit();
		}
	}
</script>

<!-- Marker definitions for the UML edge ends. They live once, here, because SVG
     marker references are document-global — every edge points at these three
     rather than emitting its own copy. `var(--…)` has to go through `style`:
     a presentation attribute would not resolve it. -->
<svg class="absolute h-0 w-0" aria-hidden="true">
	<defs>
		<marker id="uml-gen" markerWidth="16" markerHeight="14" refX="14" refY="7" orient="auto">
			<path
				d="M0,0 L14,7 L0,14 z"
				style="fill: var(--background); stroke: var(--muted-foreground); stroke-width: 1.4;"
			/>
		</marker>
		<marker id="uml-diamond" markerWidth="18" markerHeight="10" refX="1" refY="5" orient="auto">
			<path d="M1,5 L9,1 L17,5 L9,9 z" style="fill: var(--muted-foreground);" />
		</marker>
		<marker id="uml-arrow" markerWidth="12" markerHeight="10" refX="10" refY="5" orient="auto">
			<path d="M0,0 L10,5 L0,10" style="fill: none; stroke: var(--ring); stroke-width: 1.5;" />
		</marker>
	</defs>
</svg>

{#if view.parseErrors.length > 0}
	<!-- No toolbar either: with nothing parsed there is no diagram to arrange,
	     collapse or add to, and a create button here would silently no-op. -->
	<div class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
		<p class="text-sm text-muted-foreground">
			The draft has syntax errors — fix them in the YAML view.
		</p>
		<Button size="sm" variant="outline" onclick={() => setMetamodelView('yaml')}>
			Open the YAML view
		</Button>
	</div>
{:else}
	<div class="flex h-full min-h-0 flex-col">
		<div class="flex flex-wrap items-center gap-2 border-b border-border px-2 py-1.5 text-xs">
			<!-- Permanent, not conditional: re-arranging is how you recover a canvas
			     a peer's edits (or your own) have made unreadable. -->
			<Button size="sm" variant="outline" onclick={() => void runAutoArrange()}>Auto-arrange</Button
			>
			<Button size="sm" variant="outline" onclick={() => void flow.fitView()}>Fit view</Button>
			<Button size="sm" variant="ghost" onclick={() => setAllCollapsed(true)}>Collapse all</Button>
			<Button size="sm" variant="ghost" onclick={() => setAllCollapsed(false)}>Expand all</Button>
			<MetamodelSearch />
			<div class="ml-auto flex items-center gap-2">
				{#if issueCount > 0}
					<!-- The errors live in the YAML, and only the YAML view can show
					     WHERE, so the badge is a jump rather than a tooltip. -->
					<button
						type="button"
						class="rounded border border-destructive/40 bg-destructive/15 px-2 py-0.5 text-[11px] text-destructive"
						data-testid="mm-issue-badge"
						title="Open the YAML view to see the lint errors"
						onclick={() => setMetamodelView('yaml')}
					>
						{issueCount} issue{issueCount === 1 ? '' : 's'}
					</button>
				{/if}
				{#if readOnly}
					<span class="text-muted-foreground/70" data-testid="mm-readonly-note">
						{readOnlyNote}
					</span>
				{:else}
					<Button size="sm" onclick={createElementType}>+ Element type</Button>
					<Button size="sm" variant="outline" onclick={createEnum}>+ Enum</Button>
				{/if}
			</div>
		</div>

		<div class="flex min-h-0 flex-1">
			<!-- `application` is the honest role for a canvas whose own keys matter,
			     and it is what lets Ctrl/Cmd+Z reach the canvas WITHOUT a window-level
			     listener that would swallow undo from any text field on the page. The
			     rule below does not recognise it as interactive. -->
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<div
				class="relative min-h-0 flex-1"
				role="application"
				aria-label="Metamodel diagram"
				tabindex="-1"
				onkeydown={onKeydown}
				onpointermove={(e) => noteHoverCursor({ x: e.clientX, y: e.clientY })}
			>
				<SvelteFlow
					bind:nodes={flowNodes}
					bind:edges={flowEdges}
					{nodeTypes}
					{edgeTypes}
					fitView
					minZoom={0.05}
					colorMode="dark"
					nodesDraggable={canDragLayout}
					nodesConnectable={!readOnly}
					elementsSelectable
					panOnDrag
					style={CANVAS_GROUND}
					onnodeclick={({ node }) => selectDiagramNode(selectionForNodeId(node.id))}
					onedgeclick={({ edge }) => {
						const relName = (edge.data as { relName?: string } | undefined)?.relName;
						if (relName !== undefined) selectDiagramNode({ kind: 'relationship', name: relName });
					}}
					onnodedragstop={({ nodes }) => {
						for (const n of nodes) moveNode(n.id, n.position);
					}}
					onbeforeconnect={onBeforeConnect}
					onpaneclick={() => selectDiagramNode(null)}
					onmove={(_, viewport) => noteZoom(viewport.zoom)}
					onnodepointerenter={({ node }) => setDiagramHover({ kind: 'node', id: node.id })}
					onnodepointerleave={() => setDiagramHover(null)}
					onedgepointerenter={({ edge }) =>
						setDiagramHover({
							kind: 'edge',
							id: edge.id,
							relName: (edge.data as { relName?: string } | undefined)?.relName ?? null
						})}
					onedgepointerleave={() => setDiagramHover(null)}
				></SvelteFlow>

				{#if pendingConnection !== null && view.mm !== null}
					<ConnectionPopover
						mm={view.mm}
						source={pendingConnection.source}
						target={pendingConnection.target}
						onclose={() => (pendingConnection = null)}
					/>
				{/if}

				{#if lodTooltip !== null && hoverCursor !== null}
					<!-- ONE overlay owned here, fed by the hover store — not a per-node
					     tooltip. `fixed` + clientX/Y sidesteps canvas-space math,
					     and `lodTooltipAnchor` flips it to the other side of the cursor
					     near a window edge — which on this surface means the RIGHT edge,
					     where the form panel and the collapsed rail sit. The window size is
					     read at position time rather than tracked, so a resize with the
					     pointer parked leaves the tooltip on its previous anchor until the
					     next move corrects it — cheaper than a resize listener for a
					     transient that only exists while a pointer is over the canvas.
					     `max-width` is what makes `LOD_TOOLTIP_MAX_W` the honest worst case
					     the flip decides against. -->
					<div
						class="pointer-events-none fixed z-50 rounded border border-border bg-popover px-2 py-1 text-xs text-foreground shadow-lg"
						style="max-width: {LOD_TOOLTIP_MAX_W}px; {tooltipStyle(
							lodTooltipAnchor(hoverCursor, {
								width: window.innerWidth,
								height: window.innerHeight
							})
						)}"
						data-testid="mm-lod-tooltip"
					>
						{lodTooltip}
					</div>
				{/if}
			</div>

			{#if !panel.collapsed}
				<!-- The attribute half of the surface. Fixed 320px; the aside itself
				     is a flex column so the Hide-panel button sits OUTSIDE the
				     scrolling region below (an absolutely-positioned child of a
				     scroll container scrolls away with it — `top`/`right` resolve
				     before the scroll offset applies) and stays reachable no matter
				     how tall a type's property list gets. Collapsible: hidden, the
				     canvas takes the full width and the rail below stands in. -->
				<aside class="relative flex w-80 shrink-0 flex-col border-l border-border">
					<button
						type="button"
						class="absolute right-1.5 top-1.5 z-10 rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
						title="Hide panel"
						aria-label="Hide panel"
						data-testid="mm-panel-hide"
						onclick={() => setMetamodelPanelCollapsed(true)}
					>
						<ChevronsRight class="h-3.5 w-3.5" />
					</button>
					<!-- `min-h-0` lets this pane shrink below its content's height inside
					     the flex column above, which is what makes `overflow-y-auto`
					     actually engage instead of the column growing to fit. -->
					<div class="flex-1 min-h-0 overflow-y-auto">
						<MetamodelFormPanel {readOnly} />
					</div>
				</aside>
			{:else}
				<!-- Collapsed rail. A selection landing from a CANVAS click does not
				     force the panel open — the dot is the hint that one is waiting;
				     search/TOC picks reopen via revealSelection. -->
				<div class="flex shrink-0 flex-col items-center border-l border-border px-0.5 pt-1.5">
					<button
						type="button"
						class="relative rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
						title="Show panel"
						aria-label="Show panel"
						data-testid="mm-panel-show"
						onclick={() => setMetamodelPanelCollapsed(false)}
					>
						<ChevronsLeft class="h-3.5 w-3.5" />
						{#if view.selection !== null}
							<span
								class="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-primary"
								data-testid="mm-panel-selection-dot"
							></span>
						{/if}
					</button>
				</div>
			{/if}
		</div>
	</div>
{/if}
