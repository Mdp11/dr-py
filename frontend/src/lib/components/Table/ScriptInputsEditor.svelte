<script lang="ts">
	// The Inputs block of a script column: one row per named earlier column
	// the snippet reads as `inputs[name]`. Fully controlled — emits a whole
	// new list via `onChange`. Refs are backward-only, so the picker (a
	// column-only ColumnSourceEditor) lists only columns before this one.
	import type { Column, ColumnSource, RowSource, ScriptInput } from '$lib/api/types';
	import ColumnSourceEditor from './ColumnSourceEditor.svelte';

	let {
		inputs,
		columns,
		columnIndex,
		rowSource,
		onChange
	}: {
		inputs: ScriptInput[];
		columns: Column[];
		columnIndex: number;
		rowSource: RowSource | null;
		onChange: (next: ScriptInput[]) => void;
	} = $props();

	// Mirrors the server's identifier check (core/table/schema.py's
	// ScriptInput.name) — the backend re-validates regardless.
	const PY_KEYWORDS = new Set([
		'False',
		'None',
		'True',
		'and',
		'as',
		'assert',
		'async',
		'await',
		'break',
		'class',
		'continue',
		'def',
		'del',
		'elif',
		'else',
		'except',
		'finally',
		'for',
		'from',
		'global',
		'if',
		'import',
		'in',
		'is',
		'lambda',
		'nonlocal',
		'not',
		'or',
		'pass',
		'raise',
		'return',
		'try',
		'while',
		'with',
		'yield'
	]);

	function nameError(name: string, i: number): string | null {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || PY_KEYWORDS.has(name))
			return 'not a valid identifier';
		if (inputs.some((o, j) => j !== i && o.name === name)) return 'duplicate name';
		return null;
	}

	function add(): void {
		const taken = new Set(inputs.map((i) => i.name));
		let n = inputs.length + 1;
		while (taken.has(`input${n}`)) n++;
		onChange([
			...inputs,
			{ name: `input${n}`, ref: { kind: 'column', index: columnIndex - 1, step_index: null } }
		]);
	}
	function rename(i: number, e: Event): void {
		const name = (e.currentTarget as HTMLInputElement).value;
		onChange(inputs.map((inp, j) => (j === i ? { ...inp, name } : inp)));
	}
	function retarget(i: number, source: ColumnSource): void {
		if (source.kind !== 'column') return;
		onChange(inputs.map((inp, j) => (j === i ? { ...inp, ref: source } : inp)));
	}
	function remove(i: number): void {
		onChange(inputs.filter((_, j) => j !== i));
	}
</script>

<div class="space-y-1" data-testid="script-inputs-editor">
	{#each inputs as inp, i (i)}
		<div class="flex flex-wrap items-center gap-2">
			<input
				aria-label="Input name"
				class="w-24 rounded border border-input bg-card px-1 py-0.5 font-mono"
				value={inp.name}
				oninput={(e) => rename(i, e)}
			/>
			<ColumnSourceEditor
				source={inp.ref}
				{columns}
				{columnIndex}
				{rowSource}
				allowRow={false}
				label="reads"
				onSourceChange={(s) => retarget(i, s)}
			/>
			<button
				type="button"
				aria-label="Remove input"
				class="text-muted-foreground"
				onclick={() => remove(i)}
			>
				×
			</button>
			{#if nameError(inp.name, i)}
				<span data-testid="input-name-error" class="text-destructive">{nameError(inp.name, i)}</span
				>
			{/if}
		</div>
	{/each}
	<button
		type="button"
		aria-label="Add input"
		class="rounded border border-border px-1.5 py-0.5"
		disabled={columnIndex === 0}
		onclick={add}
	>
		+ input
	</button>
</div>
