<script lang="ts">
	import type { PropertyDef } from '$lib/api/types';
	import { parseMultiplicity } from '$lib/metamodel/helpers';
	import { getMetamodel } from '$lib/state';
	import { Plus, Trash2 } from '@lucide/svelte';
	import ElementRefPicker from './ElementRefPicker.svelte';

	type Props = {
		propDef: PropertyDef;
		value: unknown;
		onChange: (next: unknown) => void;
	};

	let { propDef, value, onChange }: Props = $props();

	const mm = $derived(getMetamodel());
	const mult = $derived(parseMultiplicity(propDef.multiplicity));
	const isMany = $derived(mult.upper === null || mult.upper > 1);

	type Kind = 'string' | 'integer' | 'float' | 'boolean' | 'date' | 'enum' | 'element' | 'unknown';

	const kind = $derived.by((): Kind => {
		const dt = propDef.datatype;
		if (dt === 'string' || dt === 'integer' || dt === 'float' || dt === 'boolean' || dt === 'date')
			return dt;
		if (mm !== null) {
			if (mm.enums[dt]) return 'enum';
			if (mm.elements.find((et) => et.name === dt)) return 'element';
		}
		return 'unknown';
	});

	const enumValues = $derived.by((): string[] => {
		if (kind !== 'enum' || mm === null) return [];
		return mm.enums[propDef.datatype] ?? [];
	});

	const annotation = $derived(`${propDef.datatype} · ${propDef.multiplicity}`);

	// Convert value into a normalized array for many-typed fields.
	const arrayValue = $derived.by((): unknown[] => {
		if (Array.isArray(value)) return value;
		if (value === undefined || value === null) return [];
		return [value];
	});

	function emitArray(next: unknown[]): void {
		onChange(next.length === 0 ? null : next);
	}

	function emitScalar(next: unknown): void {
		if (next === '' || next === undefined) onChange(null);
		else onChange(next);
	}

	// --- Facet validation ---------------------------------------------------
	function validateOne(v: unknown): string | null {
		if (v === null || v === undefined || v === '') return null;
		if (kind === 'string' && typeof v === 'string') {
			if (propDef.max_length !== null && v.length > propDef.max_length) {
				return `max length ${propDef.max_length}`;
			}
			if (propDef.pattern !== null) {
				try {
					if (!new RegExp(propDef.pattern).test(v)) {
						return `does not match pattern ${propDef.pattern}`;
					}
				} catch {
					return 'invalid pattern in metamodel';
				}
			}
		}
		if ((kind === 'integer' || kind === 'float') && typeof v === 'number') {
			if (propDef.min !== null && v < propDef.min) return `min ${propDef.min}`;
			if (propDef.max !== null && v > propDef.max) return `max ${propDef.max}`;
		}
		return null;
	}

	const multiplicityWarning = $derived.by((): string | null => {
		const count = isMany ? arrayValue.length : value === null || value === undefined || value === '' ? 0 : 1;
		if (mult.lower >= 1 && count === 0) return 'required';
		if (mult.upper !== null && count > mult.upper) return `max ${mult.upper} values`;
		return null;
	});

	const facetWarning = $derived.by((): string | null => {
		if (isMany) {
			for (let i = 0; i < arrayValue.length; i++) {
				const w = validateOne(arrayValue[i]);
				if (w) return `[${i}] ${w}`;
			}
			return null;
		}
		return validateOne(value);
	});

	// --- Scalar handlers ---------------------------------------------------
	function onStringInput(e: Event): void {
		const v = (e.target as HTMLInputElement | HTMLTextAreaElement).value;
		emitScalar(v);
	}
	function onNumberInput(e: Event): void {
		const raw = (e.target as HTMLInputElement).value;
		if (raw === '') {
			onChange(null);
			return;
		}
		const n = kind === 'integer' ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
		if (Number.isFinite(n)) onChange(n);
	}
	function onBooleanChange(e: Event): void {
		const next = (e.target as HTMLInputElement).checked;
		// Avoid emitting a useless op when the boolean is already (effectively) false.
		if (next === false && (value === undefined || value === null || value === false)) return;
		onChange(next);
	}
	function onDateInput(e: Event): void {
		emitScalar((e.target as HTMLInputElement).value);
	}
	function onEnumChange(e: Event): void {
		const v = (e.target as HTMLSelectElement).value;
		emitScalar(v);
	}
	function onMultiEnumChange(e: Event): void {
		const opts = (e.target as HTMLSelectElement).selectedOptions;
		const next: string[] = [];
		for (const o of opts) next.push(o.value);
		emitArray(next);
	}

	// --- Array helpers -----------------------------------------------------
	function updateAt(i: number, v: unknown): void {
		const next = arrayValue.slice();
		next[i] = v;
		emitArray(next);
	}
	function removeAt(i: number): void {
		const next = arrayValue.slice();
		next.splice(i, 1);
		emitArray(next);
	}
	function defaultForKind(): unknown {
		switch (kind) {
			case 'string':
				return '';
			case 'integer':
			case 'float':
				return 0;
			case 'boolean':
				return false;
			case 'date':
				return '';
			case 'enum':
				return enumValues[0] ?? '';
			case 'element':
				return null;
			default:
				return null;
		}
	}
	function addOne(): void {
		emitArray([...arrayValue, defaultForKind()]);
	}

	const useTextarea = $derived(
		kind === 'string' && propDef.max_length !== null && propDef.max_length > 200
	);

	const inputCls =
		'h-7 w-full rounded border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-xs text-zinc-100 outline-none focus:border-zinc-600';
	const selectCls =
		'h-7 w-full rounded border border-zinc-800 bg-zinc-900 px-1 text-xs text-zinc-100 outline-none focus:border-zinc-600';
	const textareaCls =
		'w-full rounded border border-zinc-800 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-zinc-600';
</script>

<div class="flex flex-col gap-1">
	<div class="flex items-baseline gap-2">
		<span class="text-xs font-medium text-zinc-200">{propDef.name}</span>
		<span class="font-mono text-[10px] text-zinc-500">{annotation}</span>
	</div>

	{#if kind === 'unknown'}
		<input
			type="text"
			class={inputCls}
			disabled
			value={value === undefined || value === null ? '' : String(value)}
		/>
		<span class="text-[10px] text-amber-400">unknown datatype: {propDef.datatype}</span>
	{:else if !isMany}
		{#if kind === 'string'}
			{#if useTextarea}
				<textarea
					class={textareaCls}
					rows={4}
					value={typeof value === 'string' ? value : ''}
					oninput={onStringInput}
				></textarea>
			{:else}
				<input
					type="text"
					class={inputCls}
					value={typeof value === 'string' ? value : ''}
					oninput={onStringInput}
				/>
			{/if}
		{:else if kind === 'integer'}
			<input
				type="number"
				step="1"
				class={inputCls}
				value={typeof value === 'number' ? value : ''}
				oninput={onNumberInput}
			/>
		{:else if kind === 'float'}
			<input
				type="number"
				step="any"
				class={inputCls}
				value={typeof value === 'number' ? value : ''}
				oninput={onNumberInput}
			/>
		{:else if kind === 'boolean'}
			<label class="flex items-center gap-2 text-xs text-zinc-300">
				<input type="checkbox" checked={value === true} onchange={onBooleanChange} />
				<span>{value === true ? 'true' : 'false'}</span>
			</label>
		{:else if kind === 'date'}
			<input
				type="date"
				class={inputCls}
				value={typeof value === 'string' ? value : ''}
				oninput={onDateInput}
			/>
		{:else if kind === 'enum'}
			<select
				class={selectCls}
				value={typeof value === 'string' ? value : ''}
				onchange={onEnumChange}
			>
				{#if mult.lower === 0}
					<option value="">(unset)</option>
				{/if}
				{#each enumValues as v (v)}
					<option value={v}>{v}</option>
				{/each}
			</select>
		{:else if kind === 'element'}
			<ElementRefPicker
				valueId={typeof value === 'string' ? value : null}
				targetTypeName={propDef.datatype}
				onChange={(id) => onChange(id)}
			/>
		{/if}
	{:else}
		<!-- Multi-valued field -->
		{#if kind === 'enum'}
			<select
				class="min-h-[80px] w-full rounded border border-zinc-800 bg-zinc-900 px-1 py-1 text-xs text-zinc-100 outline-none focus:border-zinc-600"
				multiple
				onchange={onMultiEnumChange}
			>
				{#each enumValues as v (v)}
					<option value={v} selected={arrayValue.includes(v)}>{v}</option>
				{/each}
			</select>
		{:else}
			<ul class="flex flex-col gap-1">
				{#each arrayValue as item, i (i)}
					<li class="flex items-center gap-1">
						<div class="flex-1">
							{#if kind === 'string'}
								<input
									type="text"
									class={inputCls}
									value={typeof item === 'string' ? item : ''}
									oninput={(e) => updateAt(i, (e.target as HTMLInputElement).value)}
								/>
							{:else if kind === 'integer'}
								<input
									type="number"
									step="1"
									class={inputCls}
									value={typeof item === 'number' ? item : ''}
									oninput={(e) => {
										const raw = (e.target as HTMLInputElement).value;
										if (raw === '') updateAt(i, null);
										else {
											const n = Number.parseInt(raw, 10);
											if (Number.isFinite(n)) updateAt(i, n);
										}
									}}
								/>
							{:else if kind === 'float'}
								<input
									type="number"
									step="any"
									class={inputCls}
									value={typeof item === 'number' ? item : ''}
									oninput={(e) => {
										const raw = (e.target as HTMLInputElement).value;
										if (raw === '') updateAt(i, null);
										else {
											const n = Number.parseFloat(raw);
											if (Number.isFinite(n)) updateAt(i, n);
										}
									}}
								/>
							{:else if kind === 'boolean'}
								<label class="flex items-center gap-2 text-xs text-zinc-300">
									<input
										type="checkbox"
										checked={item === true}
										onchange={(e) => updateAt(i, (e.target as HTMLInputElement).checked)}
									/>
									<span>{item === true ? 'true' : 'false'}</span>
								</label>
							{:else if kind === 'date'}
								<input
									type="date"
									class={inputCls}
									value={typeof item === 'string' ? item : ''}
									oninput={(e) => updateAt(i, (e.target as HTMLInputElement).value)}
								/>
							{:else if kind === 'element'}
								<ElementRefPicker
									valueId={typeof item === 'string' ? item : null}
									targetTypeName={propDef.datatype}
									onChange={(id) => updateAt(i, id)}
								/>
							{/if}
						</div>
						<button
							type="button"
							class="text-zinc-500 hover:text-red-400"
							onclick={() => removeAt(i)}
							aria-label="Remove"
						>
							<Trash2 class="h-3 w-3" />
						</button>
					</li>
				{/each}
			</ul>
			<button
				type="button"
				class="mt-1 inline-flex w-fit items-center gap-1 rounded border border-zinc-800 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800"
				onclick={addOne}
			>
				<Plus class="h-3 w-3" /> Add
			</button>
		{/if}
	{/if}

	{#if multiplicityWarning !== null}
		<span class="text-[10px] text-red-400">{multiplicityWarning}</span>
	{/if}
	{#if facetWarning !== null}
		<span class="text-[10px] text-red-400">{facetWarning}</span>
	{/if}
</div>
