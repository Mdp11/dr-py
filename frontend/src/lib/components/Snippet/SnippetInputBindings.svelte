<script lang="ts">
	// The Test panel's binding rows for a two-argument `value(elements,
	// inputs)`: one row per input the hosting script column declares. The
	// grid resolves these from the referenced column's cell for the row it is
	// computing; a console run has no row, so they are bound by hand here.
	// CONTROLLED — owns no binding state, emits a whole new map via
	// `onChange`, exactly like ElementContextRow's own add/remove contract.
	import { emptyBinding, type DeclaredInput, type InputBinding } from '$lib/snippet/run-inputs';
	import type { SnippetBoundElement } from '$lib/state';
	import ElementContextRow from './ElementContextRow.svelte';

	let {
		declared,
		bindings,
		onChange
	}: {
		declared: DeclaredInput[];
		bindings: Record<string, InputBinding>;
		onChange: (next: Record<string, InputBinding>) => void;
	} = $props();

	function bindingOf(input: DeclaredInput): InputBinding {
		return bindings[input.name] ?? emptyBinding(input.kind);
	}

	function set(name: string, binding: InputBinding): void {
		onChange({ ...bindings, [name]: binding });
	}

	function setKind(input: DeclaredInput, e: Event): void {
		const kind = (e.currentTarget as HTMLSelectElement).value as InputBinding['kind'];
		// Deliberately drops the other kind's bound value: an element list and
		// a value list have nothing to carry across, and keeping a stale one
		// alive off-screen would ship it on the next run.
		set(input.name, emptyBinding(kind));
	}

	function addElement(input: DeclaredInput, id: string, label: string): void {
		const bound = bindingOf(input);
		if (bound.kind !== 'elements' || bound.elements.some((e) => e.id === id)) return;
		set(input.name, { kind: 'elements', elements: [...bound.elements, { id, label }] });
	}

	function setElements(input: DeclaredInput, elements: SnippetBoundElement[]): void {
		set(input.name, { kind: 'elements', elements });
	}
</script>

<div class="border-b border-border px-3 py-2 text-xs" data-testid="snippet-input-bindings">
	{#each declared as input (input.name)}
		{@const bound = bindingOf(input)}
		<div class="flex flex-wrap items-center gap-2 py-0.5">
			<span class="font-mono text-foreground/90">inputs[{JSON.stringify(input.name)}]</span>
			<select
				aria-label={`Binding kind for ${input.name}`}
				class="rounded border border-input bg-card px-1 py-0.5"
				value={bound.kind}
				onchange={(e) => setKind(input, e)}
			>
				<option value="elements">elements</option>
				<option value="scalars">values</option>
			</select>
			{#if bound.kind === 'scalars'}
				<textarea
					aria-label={`Values for ${input.name}`}
					rows="1"
					class="w-64 rounded border border-input bg-card px-2 py-1 font-mono"
					placeholder="one value per line"
					value={bound.text}
					oninput={(e) => set(input.name, { kind: 'scalars', text: e.currentTarget.value })}
				></textarea>
			{/if}
		</div>
		{#if bound.kind === 'elements'}
			<!-- `entry="value"` for the append semantics; the caption is the
			     input's name, not "Elements:". -->
			<ElementContextRow
				entry="value"
				label=""
				elements={bound.elements}
				onAdd={(id, label) => addElement(input, id, label)}
				onRemove={(id) =>
					setElements(
						input,
						bound.elements.filter((e) => e.id !== id)
					)}
				onClear={() => setElements(input, [])}
			/>
		{/if}
	{/each}
</div>
