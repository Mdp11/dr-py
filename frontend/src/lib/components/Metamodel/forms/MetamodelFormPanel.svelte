<script lang="ts">
	import { Plus } from '@lucide/svelte';
	import { useSvelteFlow } from '@xyflow/svelte';

	import type { DiagramSelection } from '$lib/metamodel/diagram-build';
	import { datatypeNamespace, uniqueTypeName } from '$lib/metamodel/helpers';
	import { applyDiagramEdit, getMetamodelDiagramView, selectDiagramNode } from '$lib/state';
	import DeleteTypeDialog from './DeleteTypeDialog.svelte';
	import ElementTypeForm from './ElementTypeForm.svelte';
	import EnumForm from './EnumForm.svelte';
	import PanelSection from './PanelSection.svelte';
	import RelationshipTypeForm from './RelationshipTypeForm.svelte';
	import { addBtnCls, headingCls } from './field-classes';
	import { revealSelection } from '../reveal-action';

	/**
	 * The attribute half of the diagram surface: the canvas owns TOPOLOGY, this
	 * panel owns everything a box cannot show. It is bound to the selection —
	 * click a node, edit what it declares — and falls back to a metamodel-level
	 * overview when nothing is selected, so the panel is never a blank column.
	 *
	 * With no selection, the panel becomes a table of contents (spec
	 * 2026-08-20 §7.1): every element type, relationship type and enum,
	 * grouped into collapsible sections, each row a reveal action. This is
	 * one of only two places relationship types with NO mappings are
	 * reachable at all (the other is the toolbar search, Task 9) — they have
	 * no endpoints to anchor an edge, so the canvas cannot draw them — and it
	 * doubles as a click-to-navigate index for everything else, which the
	 * canvas alone cannot offer once a metamodel outgrows what fits on
	 * screen.
	 *
	 * The delete dialog lives HERE rather than inside each form: it is the same
	 * confirmation for all three kinds, and the panel is what has to clear the
	 * selection afterwards (the form it would have belonged to is gone by then).
	 */

	let { readOnly, onReveal }: { readOnly: boolean; onReveal?: (sel: DiagramSelection) => void } =
		$props();

	const view = $derived(getMetamodelDiagramView());
	const mm = $derived(view.mm);
	const sel = $derived(view.selection);

	const flow = useSvelteFlow();

	/** TOC rows navigate — select AND pan — through the shared action (spec
	 * §7.1), so the panel and search cannot drift. `onReveal` is the test seam. */
	function reveal(target: DiagramSelection): void {
		(onReveal ?? ((s: DiagramSelection) => revealSelection(flow, view, s)))(target);
	}

	function createRelationshipType(): void {
		if (mm === null) return;
		const name = uniqueTypeName('Relates', new Set(mm.relationships.map((r) => r.name)));
		if (
			applyDiagramEdit({ kind: 'addRelationshipType', name, containment: false, mapping: null })
		) {
			selectDiagramNode({ kind: 'relationship', name });
		}
	}

	function createEnum(): void {
		if (mm === null) return;
		// Free across the whole datatype space — see MetamodelDiagram's create pair.
		const name = uniqueTypeName('NewEnum', datatypeNamespace(mm));
		if (applyDiagramEdit({ kind: 'addEnum', name, literals: [] })) {
			selectDiagramNode({ kind: 'enum', name });
		}
	}

	const linkCls = 'w-full truncate rounded px-1 py-0.5 text-left text-[11px] hover:bg-muted';

	/** The type a Delete button asked about, or null. Captured as a full
	 * `DiagramSelection` (not just a name) so the dialog can be rendered from
	 * one place for all three kinds. */
	let pendingDelete = $state<DiagramSelection | null>(null);
</script>

{#if mm !== null}
	<div class="flex flex-col gap-3 p-2.5" data-testid="mm-form-panel">
		{#if readOnly}
			<!-- The panel scrolls independently of the toolbar that says WHY, and a
			     column of greyed-out fields with no explanation reads as broken. -->
			<p class="text-[10px] text-muted-foreground/70" data-testid="mm-panel-readonly">
				Read-only — these fields show the draft, but cannot change it.
			</p>
		{/if}
		{#if sel === null}
			<div class="flex flex-col gap-3" data-testid="mm-panel-overview">
				<div class="flex flex-col gap-0.5">
					<p class={headingCls}>Metamodel</p>
					<p class="text-[11px] text-muted-foreground">
						{mm.elements.length} element types · {mm.relationships.length} relationship types · {Object.keys(
							mm.enums
						).length} enums
					</p>
					<p class="text-[10px] text-muted-foreground/70">
						Select a box on the canvas — or a row below — to edit what it declares.
					</p>
				</div>

				<PanelSection title="Element types" count={mm.elements.length} section="elements">
					{#if mm.elements.length === 0}
						<p class="text-[11px] italic text-muted-foreground/70">None.</p>
					{:else}
						{#each mm.elements as el, i (`${i}:${el.name}`)}
							<button
								type="button"
								class={linkCls}
								data-testid="mm-toc-row"
								onclick={() => reveal({ kind: 'element', name: el.name })}
							>
								<span class="text-foreground/90">{el.name}</span>
								{#if el.abstract}<span class="text-muted-foreground/70"> — abstract</span>{/if}
							</button>
						{/each}
					{/if}
				</PanelSection>

				<PanelSection
					title="Relationship types"
					count={mm.relationships.length}
					section="relationships"
				>
					{#if mm.relationships.length === 0}
						<p class="text-[11px] italic text-muted-foreground/70">None.</p>
					{:else}
						{#each mm.relationships as rel, i (`${i}:${rel.name}`)}
							<button
								type="button"
								class={linkCls}
								data-testid="mm-toc-row"
								onclick={() => reveal({ kind: 'relationship', name: rel.name })}
							>
								<span class="text-foreground/90">{rel.name}</span>
								{#if rel.abstract}<span class="text-muted-foreground/70"> — abstract</span>{/if}
								{#if rel.mappings.length === 0}
									<span class="text-muted-foreground/70"> — no mappings</span>
								{/if}
							</button>
						{/each}
					{/if}
				</PanelSection>

				<PanelSection title="Enums" count={Object.keys(mm.enums).length} section="enums">
					{#if Object.keys(mm.enums).length === 0}
						<p class="text-[11px] italic text-muted-foreground/70">None.</p>
					{:else}
						{#each Object.entries(mm.enums) as [name, literals] (name)}
							<button
								type="button"
								class={linkCls}
								data-testid="mm-toc-row"
								onclick={() => reveal({ kind: 'enum', name })}
							>
								<span class="text-foreground/90">{name}</span>
								<span class="text-muted-foreground/70"> — {literals.length} literals</span>
							</button>
						{/each}
					{/if}
				</PanelSection>

				{#if !readOnly}
					<div class="flex flex-wrap items-center gap-1.5 border-t border-border pt-2">
						<button type="button" class={addBtnCls} onclick={createRelationshipType}>
							<Plus class="h-3 w-3" /> Relationship type
						</button>
						<button type="button" class={addBtnCls} onclick={createEnum}>
							<Plus class="h-3 w-3" /> Enum
						</button>
					</div>
				{/if}
			</div>
		{:else if sel.kind === 'element'}
			<ElementTypeForm
				{mm}
				name={sel.name}
				{readOnly}
				onRequestDelete={(name) => (pendingDelete = { kind: 'element', name })}
			/>
		{:else if sel.kind === 'relationship'}
			<RelationshipTypeForm
				{mm}
				name={sel.name}
				{readOnly}
				onRequestDelete={(name) => (pendingDelete = { kind: 'relationship', name })}
			/>
		{:else}
			<EnumForm
				{mm}
				name={sel.name}
				{readOnly}
				onRequestDelete={(name) => (pendingDelete = { kind: 'enum', name })}
			/>
		{/if}
	</div>

	{#if pendingDelete !== null}
		<DeleteTypeDialog
			sel={pendingDelete}
			{mm}
			onConfirm={() => {
				pendingDelete = null;
				// The type is gone; leaving the selection pointing at it would leave
				// the panel on a form for something the draft no longer defines.
				selectDiagramNode(null);
			}}
			onCancel={() => (pendingDelete = null)}
		/>
	{/if}
{/if}
