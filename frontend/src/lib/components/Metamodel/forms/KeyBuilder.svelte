<script lang="ts">
	import { Plus, Trash2 } from '@lucide/svelte';
	import type { Metamodel } from '$lib/api/types';
	import { effectiveProperties } from '$lib/metamodel/helpers';
	import { applyDiagramEdit } from '$lib/state';
	import { addBtnCls, headingCls, rowRemoveCls, selectCls } from './field-classes';

	/**
	 * An element type's `key` — the uniqueness DSL, built as rows instead of
	 * typed as strings. An entry is either a PROPERTY name or a relationship
	 * END (`out:<Rel>` / `in:<Rel>`), which is the whole grammar
	 * (`parse_key_entry` in `core/metamodel/schema.py`), so two row shapes cover
	 * it exhaustively.
	 *
	 * Every gesture emits ONE `setElementKey` carrying the WHOLE array: the key
	 * is a single YAML flow sequence, and a per-entry command would have to
	 * re-derive the rest of the list anyway.
	 *
	 * The property pool is EFFECTIVE (own + inherited): keying on a property
	 * declared by an ancestor is legal and common — the smart-city metamodel's
	 * `NamedElement.name` is exactly that.
	 *
	 * Relationship options exclude ABSTRACT types: an entry names an end the
	 * uniqueness validator walks at runtime, and an abstract type has no
	 * instances to walk.
	 */

	let {
		mm,
		name,
		readOnly
	}: {
		mm: Metamodel;
		name: string;
		readOnly: boolean;
	} = $props();

	const el = $derived(mm.elements.find((e) => e.name === name) ?? null);
	const entries = $derived<string[]>(el?.key ?? []);
	const propNames = $derived(effectiveProperties(mm, name).map((p) => p.name));
	const relNames = $derived(mm.relationships.filter((r) => !r.abstract).map((r) => r.name));

	interface Row {
		dir: 'out' | 'in' | null;
		value: string;
	}

	function parseEntry(entry: string): Row {
		if (entry.startsWith('out:')) return { dir: 'out', value: entry.slice(4) };
		if (entry.startsWith('in:')) return { dir: 'in', value: entry.slice(3) };
		return { dir: null, value: entry };
	}

	/** An emptied key is `null` (the key is DROPPED from the YAML), never `[]`:
	 * a declared key with no entries would key every instance on nothing. */
	function emit(next: string[]): void {
		applyDiagramEdit({ kind: 'setElementKey', name, key: next.length === 0 ? null : next });
	}

	function replace(index: number, entry: string): void {
		emit(entries.map((e, i) => (i === index ? entry : e)));
	}
</script>

<div class="flex flex-col gap-1.5">
	<p class={headingCls}>Key</p>

	{#if entries.length === 0}
		<p class="text-[11px] italic text-muted-foreground/70">No key — instances are not unique.</p>
	{/if}

	{#each entries as entry, i (`${i}:${entry}`)}
		{@const row = parseEntry(entry)}
		<div class="flex items-center gap-1" data-testid="mm-key-entry">
			{#if row.dir === null}
				<select
					class={selectCls}
					data-testid="mm-key-property"
					disabled={readOnly}
					value={row.value}
					onchange={(e) => replace(i, e.currentTarget.value)}
				>
					{#each propNames as p, j (`${j}:${p}`)}<option value={p}>{p}</option>{/each}
					<!-- A key entry naming a property the draft dropped stays visible
					     rather than silently re-pointing at whatever sorts first. -->
					{#if !propNames.includes(row.value)}
						<option value={row.value}>{row.value} (unknown)</option>
					{/if}
				</select>
			{:else}
				<select
					class="{selectCls} w-20 flex-none"
					data-testid="mm-key-direction"
					disabled={readOnly}
					value={row.dir}
					onchange={(e) => replace(i, `${e.currentTarget.value}:${row.value}`)}
				>
					<option value="out">out</option>
					<option value="in">in</option>
				</select>
				<select
					class={selectCls}
					data-testid="mm-key-relationship"
					disabled={readOnly}
					value={row.value}
					onchange={(e) => replace(i, `${row.dir}:${e.currentTarget.value}`)}
				>
					{#each relNames as r, j (`${j}:${r}`)}<option value={r}>{r}</option>{/each}
					{#if !relNames.includes(row.value)}
						<option value={row.value}>{row.value} (unknown)</option>
					{/if}
				</select>
			{/if}
			{#if !readOnly}
				<button
					type="button"
					class={rowRemoveCls}
					data-testid="mm-key-remove"
					title={`Remove key entry ${entry}`}
					aria-label={`Remove key entry ${entry}`}
					onclick={() => emit(entries.filter((_, j) => j !== i))}
				>
					<Trash2 class="h-3 w-3" />
				</button>
			{/if}
		</div>
	{/each}

	{#if !readOnly}
		<div class="flex flex-wrap items-center gap-1.5">
			<button
				type="button"
				class={addBtnCls}
				data-testid="mm-key-add-prop"
				disabled={propNames.length === 0}
				title={propNames.length === 0 ? 'This type has no properties to key on' : undefined}
				onclick={() => emit([...entries, propNames[0]])}
			>
				<Plus class="h-3 w-3" /> property entry
			</button>
			<button
				type="button"
				class={addBtnCls}
				data-testid="mm-key-add-rel"
				disabled={relNames.length === 0}
				title={relNames.length === 0 ? 'No concrete relationship types to key on' : undefined}
				onclick={() => emit([...entries, `out:${relNames[0]}`])}
			>
				<Plus class="h-3 w-3" /> relationship entry
			</button>
			{#if entries.length > 0}
				<button type="button" class={addBtnCls} data-testid="mm-key-clear" onclick={() => emit([])}>
					No key
				</button>
			{/if}
		</div>
	{/if}
</div>
