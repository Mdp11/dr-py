<script lang="ts">
	// The row-source picker for a table definition: scope | navigation |
	// chains. `scope` reuses `ScopeEditor.svelte` directly — `ScopeRows` is
	// structurally identical to `NavScope`. `navigation`/`chains` carry a
	// NavigationSource: either a saved-navigation REF (a `<select>` over the
	// artifact library) or an INLINE definition edited with the real
	// navigation builder via an EMBEDDED draft (rowContext: false — a row
	// source defines the rows, so it keeps an ordinary Scope start and its
	// previews need no row binding).
	import { onDestroy } from 'svelte';
	import {
		closeDraft,
		ensureEmbeddedDraft,
		getArtifactHeaders,
		getDraft,
		updateTableDefinition
	} from '$lib/state';
	import { emptyPath } from '$lib/navigation/tree';
	import type { NavigationDefinition, RowSource, TableDefinition } from '$lib/api/types';
	import NavigationNode from '../Navigation/NavigationNode.svelte';
	import ScopeEditor from '../Navigation/ScopeEditor.svelte';

	let { tabId, defn }: { tabId: string; defn: TableDefinition } = $props();

	const rowSource = $derived(defn.row_source);
	const navHeaders = $derived(getArtifactHeaders().filter((a) => a.kind === 'navigation'));

	const embId = `navemb:${crypto.randomUUID()}`;
	const inline = $derived(rowSource.kind !== 'scope' && rowSource.navigation.definition != null);
	const embDraft = $derived(getDraft(embId));

	// Kept while in ref mode so toggling doesn't lose an inline definition
	// within one mount. Only the active mode is written to the definition.
	// `$state.raw` for the same reason as NavigationColumnEditor's lastInline:
	// a deep `$state` returns a PROXY that would leak into the table
	// definition and break every later `structuredClone` of it.
	let lastInline = $state.raw<NavigationDefinition | null>(null);

	function apply(next: RowSource): void {
		updateTableDefinition(tabId, { ...defn, row_source: next });
	}

	// Lifecycle: an inline row source needs its embedded draft (a saved table
	// reopened with one in the payload); scope/ref modes must not leave one.
	$effect(() => {
		if (inline && rowSource.kind !== 'scope' && !getDraft(embId)) {
			ensureEmbeddedDraft(embId, rowSource.navigation.definition!, {
				rowContext: false,
				rowElementId: null
			});
		} else if (!inline && getDraft(embId)) {
			closeDraft(embId);
		}
	});

	// Mirror embedded-draft edits back into the row source (reference
	// equality is the loop guard, same as NavigationColumnEditor).
	$effect(() => {
		if (!inline || !embDraft || rowSource.kind === 'scope') return;
		if (embDraft.definition !== rowSource.navigation.definition) {
			apply({ ...rowSource, navigation: { definition: embDraft.definition } });
		}
	});

	onDestroy(() => closeDraft(embId));

	function switchToInline(): void {
		if (rowSource.kind === 'scope' || inline) return;
		const draft = ensureEmbeddedDraft(embId, lastInline ?? emptyPath(), {
			rowContext: false,
			rowElementId: null
		});
		apply({ ...rowSource, navigation: { definition: draft.definition } });
	}

	function switchToRef(): void {
		if (rowSource.kind === 'scope' || !inline) return;
		lastInline = rowSource.navigation.definition ?? null;
		closeDraft(embId);
		apply({ ...rowSource, navigation: {} });
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
			Scope
		</span>
		<select
			aria-label="Row source kind"
			value={rowSource.kind}
			onchange={onKindChange}
			class="rounded border border-input bg-card px-1 py-0.5 text-xs"
		>
			<option value="scope">Elements</option>
			<option value="navigation">Navigation (per step)</option>
			<option value="chains">Navigation (chains)</option>
		</select>
	</div>

	{#if rowSource.kind === 'scope'}
		<ScopeEditor scope={rowSource} onChange={(next) => apply({ ...next, kind: 'scope' })} />
	{:else}
		<div class="flex flex-wrap items-center gap-2">
			<div class="flex overflow-hidden rounded border border-input text-[11px]">
				<button
					type="button"
					data-testid="rowsource-mode-ref"
					class="px-1.5 py-0.5 {inline ? 'hover:bg-muted' : 'bg-muted font-medium'}"
					onclick={switchToRef}
				>
					saved
				</button>
				<button
					type="button"
					data-testid="rowsource-mode-inline"
					class="border-l border-input px-1.5 py-0.5 {inline
						? 'bg-muted font-medium'
						: 'hover:bg-muted'}"
					onclick={switchToInline}
				>
					inline
				</button>
			</div>
			{#if !inline}
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
			{/if}
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
		{#if inline && embDraft}
			<div data-testid="inline-rowsource-editor" class="mt-1">
				<NavigationNode tabId={embId} path={[]} />
			</div>
		{/if}
	{/if}
</div>
