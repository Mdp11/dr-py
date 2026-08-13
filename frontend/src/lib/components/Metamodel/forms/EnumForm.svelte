<script lang="ts">
	import { ChevronDown, ChevronUp, Plus, Trash2 } from '@lucide/svelte';
	import type { Metamodel } from '$lib/api/types';
	import { typeNameCollision } from '$lib/metamodel/helpers';
	import { applyDiagramEdit, selectDiagramNode } from '$lib/state';
	import {
		addBtnCls,
		dangerBtnCls,
		headingCls,
		inputCls,
		labelCls,
		rowRemoveCls
	} from './field-classes';

	/**
	 * An enum: a name and an ORDERED list of literals. Order is meaningful —
	 * it is what a picker built from this enum renders — so the rows carry
	 * move-up/move-down instead of being sorted for the user.
	 *
	 * Every gesture (edit, add, remove, reorder) emits ONE `setEnumLiterals`
	 * with the WHOLE list, for the same reason `KeyBuilder` does: the literals
	 * are a single YAML flow sequence.
	 */

	let {
		mm,
		name,
		readOnly,
		onRequestDelete
	}: {
		mm: Metamodel;
		name: string;
		readOnly: boolean;
		onRequestDelete: (name: string) => void;
	} = $props();

	const literals = $derived<string[]>(mm.enums[name] ?? []);
	const known = $derived(Object.prototype.hasOwnProperty.call(mm.enums, name));

	/** Returns whether the draft actually took it: the literal INPUTS hold their
	 * own DOM value, so a refused edit has to be rolled back by hand. The
	 * button-driven gestures (add/remove/reorder) need no rollback — they own no
	 * DOM state and simply re-render from the unchanged draft. */
	function emit(next: string[]): boolean {
		return applyDiagramEdit({ kind: 'setEnumLiterals', name, literals: next });
	}

	/** Same collision guard and same inline-error interaction as the two type
	 * forms. An enum shares its name space with the element types (both are
	 * things a `datatype` can name), and a duplicate here is worse than a
	 * first-wins lookup: `enums` is a YAML MAPPING, so a second key of the same
	 * name makes the draft stop parsing outright. */
	let nameError = $state<string | null>(null);

	function commitRename(input: HTMLInputElement): void {
		const to = input.value.trim();
		nameError = null;
		if (to === name) return;
		if (to === '') {
			input.value = name;
			return;
		}
		const collision = typeNameCollision(mm, 'enum', to);
		if (collision !== null) {
			nameError = collision;
			return;
		}
		if (!applyDiagramEdit({ kind: 'renameEnum', from: name, to })) {
			input.value = name;
			return;
		}
		selectDiagramNode({ kind: 'enum', name: to });
	}

	function commitLiteral(index: number, input: HTMLInputElement): void {
		const value = input.value.trim();
		if (value === literals[index]) return;
		if (value === '' || !emit(literals.map((l, i) => (i === index ? value : l)))) {
			input.value = literals[index];
		}
	}

	/** Swap with the neighbour rather than splice-and-insert: the two are the
	 * same for a single-step move and swapping keeps the intent obvious. */
	function move(index: number, delta: number): void {
		const to = index + delta;
		if (to < 0 || to >= literals.length) return;
		const next = [...literals];
		[next[index], next[to]] = [next[to], next[index]];
		emit(next);
	}

	function addLiteral(): void {
		let candidate = 'NEW';
		let i = 2;
		while (literals.includes(candidate)) candidate = `NEW${i++}`;
		emit([...literals, candidate]);
	}
</script>

{#if !known}
	<p class="text-[11px] italic text-muted-foreground/70">This enum is no longer in the draft.</p>
{:else}
	<div class="flex flex-col gap-3">
		<label class="flex flex-col gap-0.5">
			<span class={labelCls}>Enum</span>
			<input
				class={inputCls}
				data-testid="mm-enum-name"
				disabled={readOnly}
				value={name}
				onblur={(e) => commitRename(e.currentTarget)}
				onkeydown={(e) => {
					if (e.key === 'Enter') e.currentTarget.blur();
				}}
			/>
		</label>
		{#if nameError !== null}
			<p class="text-[10px] text-destructive" data-testid="mm-enum-name-error">{nameError}</p>
		{/if}

		<div class="flex flex-col gap-1.5">
			<p class={headingCls}>Literals</p>
			{#if literals.length === 0}
				<p class="text-[11px] italic text-muted-foreground/70">No literals.</p>
			{/if}
			{#each literals as literal, i (`${i}:${literal}`)}
				<div class="flex items-center gap-1">
					<input
						class={inputCls}
						data-testid="mm-enum-literal"
						disabled={readOnly}
						value={literal}
						onblur={(e) => commitLiteral(i, e.currentTarget)}
						onkeydown={(e) => {
							if (e.key === 'Enter') e.currentTarget.blur();
						}}
					/>
					{#if !readOnly}
						<button
							type="button"
							class="text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
							data-testid="mm-enum-literal-up"
							disabled={i === 0}
							title={`Move ${literal} up`}
							aria-label={`Move ${literal} up`}
							onclick={() => move(i, -1)}
						>
							<ChevronUp class="h-3 w-3" />
						</button>
						<button
							type="button"
							class="text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
							data-testid="mm-enum-literal-down"
							disabled={i === literals.length - 1}
							title={`Move ${literal} down`}
							aria-label={`Move ${literal} down`}
							onclick={() => move(i, 1)}
						>
							<ChevronDown class="h-3 w-3" />
						</button>
						<button
							type="button"
							class={rowRemoveCls}
							data-testid="mm-enum-literal-remove"
							title={`Remove ${literal}`}
							aria-label={`Remove ${literal}`}
							onclick={() => emit(literals.filter((_, j) => j !== i))}
						>
							<Trash2 class="h-3 w-3" />
						</button>
					{/if}
				</div>
			{/each}
			{#if !readOnly}
				<button
					type="button"
					class={addBtnCls}
					data-testid="mm-enum-literal-add"
					onclick={addLiteral}
				>
					<Plus class="h-3 w-3" /> Literal
				</button>
			{/if}
		</div>

		{#if !readOnly}
			<div class="border-t border-border pt-2">
				<p class="{headingCls} mb-1">Danger zone</p>
				<button
					type="button"
					class={dangerBtnCls}
					data-testid="mm-enum-delete"
					onclick={() => onRequestDelete(name)}
				>
					<Trash2 class="h-3 w-3" /> Delete {name}
				</button>
			</div>
		{/if}
	</div>
{/if}
