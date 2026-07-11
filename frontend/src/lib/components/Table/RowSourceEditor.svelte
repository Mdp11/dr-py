<script lang="ts">
	// The row-source picker for a table definition: scope | navigation |
	// chains. `scope` reuses `ScopeEditor.svelte` directly — `ScopeRows`
	// (`{kind:'scope', types, criteria}`) is structurally identical to
	// `NavScope`, so no adapter is needed. `navigation`/`chains` embed a
	// saved-navigation REF picker (a plain `<select>` over the artifact
	// library, filtered to `kind === 'navigation'`) rather than
	// `NavigationNode.svelte` — that component is coupled to the
	// navigation-editor store's per-tab draft and has no `definition`+
	// `onChange` contract, so it cannot be embedded here. Inline
	// nav-definition editing inside a table row source is a Stage-2.1
	// deferral.
	import { getArtifactHeaders, updateTableDefinition } from '$lib/state';
	import type { RowSource, TableDefinition } from '$lib/api/types';
	import ScopeEditor from '../Navigation/ScopeEditor.svelte';

	let { tabId, defn }: { tabId: string; defn: TableDefinition } = $props();

	const rowSource = $derived(defn.row_source);
	const navHeaders = $derived(getArtifactHeaders().filter((a) => a.kind === 'navigation'));

	function apply(next: RowSource): void {
		updateTableDefinition(tabId, { ...defn, row_source: next });
	}

	function onKindChange(e: Event): void {
		const kind = (e.currentTarget as HTMLSelectElement).value;
		if (kind === 'scope') apply({ kind: 'scope', types: [], criteria: [] });
		else if (kind === 'navigation') apply({ kind: 'navigation', navigation: {}, step_index: null });
		else apply({ kind: 'chains', navigation: {} });
	}

	function onRefChange(e: Event): void {
		if (rowSource.kind === 'scope') return;
		const ref = (e.currentTarget as HTMLSelectElement).value;
		apply({ ...rowSource, navigation: ref ? { ref } : {} });
	}

	function onStepIndexChange(e: Event): void {
		if (rowSource.kind !== 'navigation') return;
		const raw = (e.currentTarget as HTMLInputElement).value.trim();
		apply({ ...rowSource, step_index: raw === '' ? null : Number(raw) });
	}
</script>

<div
	data-testid="row-source-editor"
	class="space-y-2 rounded border border-border bg-card/40 p-2 text-xs"
>
	<div class="flex flex-wrap items-center gap-2">
		<span class="font-mono text-[10px] tracking-wide text-muted-foreground/70 uppercase">
			Rows
		</span>
		<select
			aria-label="Row source kind"
			value={rowSource.kind}
			onchange={onKindChange}
			class="rounded border border-input bg-card px-1 py-0.5 text-xs"
		>
			<option value="scope">Scope</option>
			<option value="navigation">Navigation (per step)</option>
			<option value="chains">Navigation (chains)</option>
		</select>
	</div>

	{#if rowSource.kind === 'scope'}
		<ScopeEditor scope={rowSource} onChange={(next) => apply({ ...next, kind: 'scope' })} />
	{:else}
		<div class="flex flex-wrap items-center gap-2">
			<select
				aria-label="Saved navigation"
				value={rowSource.navigation.ref ?? ''}
				onchange={onRefChange}
				class="rounded border border-input bg-card px-1 py-0.5 text-xs"
			>
				<option value="">Select a saved navigation…</option>
				{#each navHeaders as h (h.id)}
					<option value={h.id}>{h.name}</option>
				{/each}
			</select>
			{#if rowSource.kind === 'navigation'}
				<label class="flex items-center gap-1 text-[11px] text-muted-foreground/70">
					step
					<input
						type="number"
						class="w-14 rounded border border-input bg-card px-1 py-0.5 text-xs"
						value={rowSource.step_index ?? ''}
						oninput={onStepIndexChange}
					/>
				</label>
			{/if}
		</div>
	{/if}
</div>
