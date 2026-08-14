<script lang="ts">
	import { untrack } from 'svelte';
	import type { Metamodel } from '$lib/api/types';
	import { isSubtype, typeNameCollision, uniqueTypeName } from '$lib/metamodel/helpers';
	import { blockBtnCls, inputCls, selectCls } from '../forms/field-classes';
	import { applyDiagramEdit, selectDiagramNode } from '$lib/state';

	/**
	 * What a dragged connection MEANS. Two element boxes joined by a gesture is
	 * ambiguous in UML — it could be a new association, another endpoint pair on
	 * an association that already exists, or a generalization — so the gesture
	 * asks instead of guessing.
	 *
	 * It is deliberately mounted over the canvas rather than being a real
	 * popover anchored to a handle: the connection has no DOM anchor once the
	 * drag ends, and Svelte Flow's edge-label renderer only exists for edges
	 * that were actually created — and none was (see `MetamodelDiagram`'s
	 * `onbeforeconnect`, which REFUSES the phantom edge so the canvas keeps
	 * showing only what the YAML says).
	 *
	 * Escape or a click outside cancels, emitting no command at all.
	 */

	let {
		mm,
		source,
		target,
		onclose
	}: {
		mm: Metamodel;
		source: string;
		target: string;
		onclose: () => void;
	} = $props();

	/** `Zone extends Building` is only offered when it cannot close a loop.
	 * `isSubtype` walks INCLUSIVELY, so the single check also rules out the
	 * self-connection case. */
	const canExtend = $derived(!isSubtype(mm, target, source));
	const existing = $derived(mm.relationships.filter((r) => !r.abstract).map((r) => r.name));

	// `untrack` because these ARE initial values on purpose: the popover is
	// mounted fresh per connection, and re-deriving the typed name from a later
	// `mm` would overwrite what the user is typing.
	let newName = $state(
		untrack(() => uniqueTypeName('Relates', new Set(mm.relationships.map((r) => r.name))))
	);
	let containment = $state(false);
	let chosen = $state(untrack(() => existing[0] ?? ''));

	/** The default name is generated free, but this field is free TEXT — so the
	 * same collision guard the rename forms use has to run here too, or the one
	 * create path a user can type into stays the way to mint a duplicate. */
	let nameError = $state<string | null>(null);

	function createType(): void {
		const name = newName.trim();
		if (name === '') return;
		const collision = typeNameCollision(mm, 'relationship', name);
		if (collision !== null) {
			nameError = collision;
			return;
		}
		if (
			applyDiagramEdit({
				kind: 'addRelationshipType',
				name,
				containment,
				mapping: { source, target }
			})
		) {
			selectDiagramNode({ kind: 'relationship', name });
		}
		onclose();
	}

	function addMapping(): void {
		if (chosen === '') return;
		applyDiagramEdit({ kind: 'addMapping', name: chosen, mapping: { source, target } });
		onclose();
	}

	function setExtends(): void {
		applyDiagramEdit({ kind: 'setElementExtends', name: source, value: target });
		onclose();
	}
</script>

<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape') onclose();
	}}
/>

<!-- The backdrop is a real button so click-away is keyboard-reachable and needs
     no a11y suppression; it sits UNDER the card in the stacking order. -->
<button
	type="button"
	class="absolute inset-0 z-10 cursor-default bg-background/40"
	aria-label="Cancel connection"
	onclick={onclose}
></button>

<div
	class="absolute left-1/2 top-10 z-20 w-72 -translate-x-1/2 rounded-lg border border-border bg-popover p-3 shadow-xl"
	data-testid="mm-connection-popover"
>
	<p class="mb-2 text-[11px] text-muted-foreground">
		Connect <span class="text-foreground/90">{source}</span> →
		<span class="text-foreground/90">{target}</span>
	</p>

	<div class="flex flex-col gap-3">
		<div class="flex flex-col gap-1">
			<p class="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
				New relationship type
			</p>
			<input
				class={inputCls}
				data-testid="mm-conn-name"
				value={newName}
				oninput={(e) => {
					newName = e.currentTarget.value;
					nameError = null;
				}}
				aria-label="Name"
			/>
			{#if nameError !== null}
				<p class="text-[10px] text-destructive" data-testid="mm-conn-name-error">{nameError}</p>
			{/if}
			<label class="flex items-center gap-2 text-[11px] text-foreground/90">
				<input
					type="checkbox"
					data-testid="mm-conn-containment"
					checked={containment}
					onchange={(e) => (containment = e.currentTarget.checked)}
				/>
				Containment
			</label>
			<button type="button" class={blockBtnCls} data-testid="mm-conn-create" onclick={createType}>
				Create
			</button>
		</div>

		{#if existing.length > 0}
			<div class="flex flex-col gap-1">
				<p class="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
					Add mapping to existing
				</p>
				<!-- Explicit value + onchange rather than `bind:value`, matching the
				     form panel's controls: every input in this feature is committed by
				     an event handler, so there is one way to read a control. -->
				<select
					class={selectCls}
					data-testid="mm-conn-existing"
					value={chosen}
					onchange={(e) => (chosen = e.currentTarget.value)}
					aria-label="Relationship type"
				>
					{#each existing as name, i (`${i}:${name}`)}<option value={name}>{name}</option>{/each}
				</select>
				<button
					type="button"
					class={blockBtnCls}
					data-testid="mm-conn-add-mapping"
					onclick={addMapping}
				>
					Add mapping
				</button>
			</div>
		{/if}

		{#if canExtend}
			<div class="flex flex-col gap-1">
				<p class="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70">
					Generalization
				</p>
				<button
					type="button"
					class={blockBtnCls}
					data-testid="mm-conn-extends"
					onclick={setExtends}
				>
					{source} extends {target}
				</button>
			</div>
		{/if}

		<button
			type="button"
			class="text-[11px] text-muted-foreground hover:text-foreground"
			data-testid="mm-conn-cancel"
			onclick={onclose}
		>
			Cancel
		</button>
	</div>
</div>
