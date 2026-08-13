<script lang="ts">
	import { Plus, Trash2 } from '@lucide/svelte';
	import type { Metamodel, PropertyDef } from '$lib/api/types';
	import { PRIMITIVE_DATATYPES } from '$lib/metamodel/helpers';
	import type { TypeRef } from '$lib/metamodel/yaml-edit';
	import { applyDiagramEdit } from '$lib/state';
	import { addBtnCls, headingCls, inputCls, rowRemoveCls, selectCls } from './field-classes';

	/**
	 * The `properties` list of an element OR a relationship type — the one
	 * editor both forms mount, since a `PropertyDef` is the same shape either
	 * side and `TypeRef` is exactly the disambiguator `yaml-edit` wants.
	 *
	 * **Every field change emits `updateProperty` with the FULL definition**,
	 * never a patch: the yaml-edit handler REPLACES the row's keys (dropping the
	 * ones at their schema default), so a partial def would silently erase the
	 * facets the user did not touch.
	 *
	 * Rows collapse to `name — datatype — mult` and open one at a time. The open
	 * row is tracked by NAME, so a rename has to move it (see `commit`) or the
	 * row the user is editing would fold shut under them.
	 */

	let {
		mm,
		owner,
		readOnly
	}: {
		mm: Metamodel;
		owner: TypeRef;
		readOnly: boolean;
	} = $props();

	const properties = $derived<PropertyDef[]>(
		owner.kind === 'element'
			? (mm.elements.find((e) => e.name === owner.name)?.properties ?? [])
			: (mm.relationships.find((r) => r.name === owner.name)?.properties ?? [])
	);

	/** The three option groups of the datatype select: what the loader accepts
	 * for a `datatype` is exactly "a primitive, an enum, or an element type"
	 * (`core/metamodel/check.py`), so the groups are that rule made visible. */
	const primitives = [...PRIMITIVE_DATATYPES];
	const enums = $derived(Object.keys(mm.enums));
	const elementTypes = $derived(mm.elements.map((e) => e.name));

	let open = $state<string | null>(null);

	const DEFAULT_PROP: PropertyDef = {
		name: 'new_property',
		datatype: 'string',
		multiplicity: '0..1',
		min: null,
		max: null,
		pattern: null,
		max_length: null
	};

	function commit(p: PropertyDef, patch: Partial<PropertyDef>): boolean {
		const next = { ...p, ...patch };
		const ok = applyDiagramEdit({ kind: 'updateProperty', owner, propName: p.name, prop: next });
		// Follow the rename: `open` keys on the property name, and the row is
		// re-rendered from the new draft the moment this returns.
		if (ok && next.name !== p.name) open = next.name;
		return ok;
	}

	/** Text commits on blur (or Enter), never per keystroke: `updateProperty`
	 * rewrites the YAML and re-lints, and doing that per character would make
	 * every rename cascade once per letter. */
	function commitText(p: PropertyDef, field: 'name' | 'multiplicity', el: HTMLInputElement): void {
		const value = el.value.trim();
		const current = p[field];
		if (value === current) return;
		if (value === '' || !commit(p, { [field]: value })) el.value = current;
	}

	/** An empty facet input means "no facet", i.e. the key is dropped from the
	 * YAML — which is why these are `null`, not `0` or `''`. */
	function commitNumber(
		p: PropertyDef,
		field: 'min' | 'max' | 'max_length',
		el: HTMLInputElement
	): void {
		const raw = el.value.trim();
		if (raw === '') {
			commit(p, { [field]: null });
			return;
		}
		const n = field === 'max_length' ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
		if (!Number.isFinite(n)) {
			el.value = p[field] === null ? '' : String(p[field]);
			return;
		}
		commit(p, { [field]: n });
	}

	function commitPattern(p: PropertyDef, el: HTMLInputElement): void {
		const raw = el.value;
		commit(p, { pattern: raw === '' ? null : raw });
	}

	function onEnter(e: KeyboardEvent): void {
		if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
	}
</script>

<div class="flex flex-col gap-1.5">
	<p class={headingCls}>Properties</p>

	{#if properties.length === 0}
		<p class="text-[11px] italic text-muted-foreground/70">No properties.</p>
	{/if}

	{#each properties as p (p.name)}
		<div class="rounded border border-border/60 bg-card/40">
			<div class="flex items-center gap-1 px-1.5 py-1">
				<button
					type="button"
					class="min-w-0 flex-1 truncate text-left text-[11px]"
					data-testid="mm-prop-row"
					aria-expanded={open === p.name}
					onclick={() => (open = open === p.name ? null : p.name)}
				>
					<span class="text-foreground/90">{p.name}</span>
					<span class="text-muted-foreground/70"> — </span>
					<span class="text-foreground/70">{p.datatype}</span>
					<span class="text-muted-foreground/70"> — {p.multiplicity}</span>
				</button>
				{#if !readOnly}
					<button
						type="button"
						class={rowRemoveCls}
						data-testid="mm-prop-remove"
						title={`Remove ${p.name}`}
						aria-label={`Remove ${p.name}`}
						onclick={() => applyDiagramEdit({ kind: 'removeProperty', owner, propName: p.name })}
					>
						<Trash2 class="h-3 w-3" />
					</button>
				{/if}
			</div>

			{#if open === p.name}
				<div class="grid grid-cols-2 gap-1.5 border-t border-border/60 px-1.5 py-1.5">
					<label class="col-span-2 flex flex-col gap-0.5">
						<span class="text-[10px] text-muted-foreground/70">Name</span>
						<input
							class={inputCls}
							data-testid="mm-prop-name"
							disabled={readOnly}
							value={p.name}
							onblur={(e) => commitText(p, 'name', e.currentTarget)}
							onkeydown={onEnter}
						/>
					</label>
					<label class="flex flex-col gap-0.5">
						<span class="text-[10px] text-muted-foreground/70">Datatype</span>
						<select
							class={selectCls}
							data-testid="mm-prop-datatype"
							disabled={readOnly}
							value={p.datatype}
							onchange={(e) => commit(p, { datatype: e.currentTarget.value })}
						>
							<optgroup label="Primitives">
								{#each primitives as dt (dt)}<option value={dt}>{dt}</option>{/each}
							</optgroup>
							<optgroup label="Enums">
								{#each enums as name (name)}<option value={name}>{name}</option>{/each}
							</optgroup>
							<optgroup label="Element types">
								{#each elementTypes as name (name)}<option value={name}>{name}</option>{/each}
							</optgroup>
							<!-- A datatype the draft no longer defines (a renamed enum the
							     cascade could not reach) would otherwise leave the select
							     showing an unrelated option. Keep it visible instead. -->
							{#if !PRIMITIVE_DATATYPES.has(p.datatype) && !enums.includes(p.datatype) && !elementTypes.includes(p.datatype)}
								<option value={p.datatype}>{p.datatype} (unknown)</option>
							{/if}
						</select>
					</label>
					<label class="flex flex-col gap-0.5">
						<span class="text-[10px] text-muted-foreground/70">Multiplicity</span>
						<input
							class={inputCls}
							data-testid="mm-prop-multiplicity"
							disabled={readOnly}
							value={p.multiplicity}
							onblur={(e) => commitText(p, 'multiplicity', e.currentTarget)}
							onkeydown={onEnter}
						/>
					</label>
					<label class="flex flex-col gap-0.5">
						<span class="text-[10px] text-muted-foreground/70">Min</span>
						<input
							class={inputCls}
							data-testid="mm-prop-min"
							type="number"
							disabled={readOnly}
							value={p.min ?? ''}
							onblur={(e) => commitNumber(p, 'min', e.currentTarget)}
							onkeydown={onEnter}
						/>
					</label>
					<label class="flex flex-col gap-0.5">
						<span class="text-[10px] text-muted-foreground/70">Max</span>
						<input
							class={inputCls}
							data-testid="mm-prop-max"
							type="number"
							disabled={readOnly}
							value={p.max ?? ''}
							onblur={(e) => commitNumber(p, 'max', e.currentTarget)}
							onkeydown={onEnter}
						/>
					</label>
					<label class="flex flex-col gap-0.5">
						<span class="text-[10px] text-muted-foreground/70">Pattern</span>
						<input
							class={inputCls}
							data-testid="mm-prop-pattern"
							disabled={readOnly}
							value={p.pattern ?? ''}
							onblur={(e) => commitPattern(p, e.currentTarget)}
							onkeydown={onEnter}
						/>
					</label>
					<label class="flex flex-col gap-0.5">
						<span class="text-[10px] text-muted-foreground/70">Max length</span>
						<input
							class={inputCls}
							data-testid="mm-prop-maxlen"
							type="number"
							disabled={readOnly}
							value={p.max_length ?? ''}
							onblur={(e) => commitNumber(p, 'max_length', e.currentTarget)}
							onkeydown={onEnter}
						/>
					</label>
				</div>
			{/if}
		</div>
	{/each}

	{#if !readOnly}
		<button
			type="button"
			class={addBtnCls}
			data-testid="mm-prop-add"
			onclick={() => applyDiagramEdit({ kind: 'addProperty', owner, prop: DEFAULT_PROP })}
		>
			<Plus class="h-3 w-3" /> Property
		</button>
	{/if}
</div>
