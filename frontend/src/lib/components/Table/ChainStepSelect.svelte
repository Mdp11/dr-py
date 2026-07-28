<script lang="ts">
	// The step picker shared by every "which step of this navigation" field:
	// RowSourceEditor's and NavigationColumnEditor's "Return elements from
	// step", and ColumnSourceEditor's "chain step" / "Step to use". Options come
	// from `chainStepOptions`, so the numbers offered here are exactly the
	// numbers the navigation editor badges (0 = the start).
	//
	// `options === null` means the definition is unknown (nothing picked yet, or
	// a saved ref still in flight): there is nothing to list, so the field
	// degrades to the free numeric input these fields used to be — the backend
	// still 422s an out-of-range index.
	//
	// Fully controlled: emits the new index (or null) via `onChange`.
	import type { ChainStepOption } from '$lib/table/chain-steps';

	let {
		options,
		value,
		emptyLabel = null,
		ariaLabel,
		testId = null,
		class: extraClass = '',
		onChange
	}: {
		options: ChainStepOption[] | null;
		/** `undefined` is accepted because the wire schemas spell the nullable
		 * step fields `.nullish()`; it reads the same as null here. */
		value: number | null | undefined;
		/** Text of the "no explicit step" choice (and the fallback input's
		 * placeholder). Null = the field has no empty state (`chain_index`). */
		emptyLabel?: string | null;
		ariaLabel: string;
		testId?: string | null;
		class?: string;
		onChange: (next: number | null) => void;
	} = $props();

	// A stored index this chain doesn't have — a definition that shrank under a
	// saved step_index. Rendered as its own option so the select shows the truth
	// instead of looking empty; the hosts' re-clamp effects then replace it.
	const orphan = $derived(
		options !== null && value != null && !options.some((o) => o.index === value) ? value : null
	);

	function onSelect(e: Event): void {
		const raw = (e.currentTarget as HTMLSelectElement).value;
		onChange(raw === '' ? null : Number(raw));
	}

	function onType(e: Event): void {
		const raw = (e.currentTarget as HTMLInputElement).value.trim();
		if (raw === '') {
			onChange(null);
			return;
		}
		const n = Math.floor(Number(raw));
		if (!Number.isFinite(n)) return;
		onChange(Math.max(0, n));
	}
</script>

{#if options !== null}
	<select
		aria-label={ariaLabel}
		data-testid={testId}
		value={value == null ? '' : String(value)}
		onchange={onSelect}
		class="max-w-[16rem] rounded border border-input bg-card px-1 py-0.5 {extraClass}"
	>
		{#if emptyLabel !== null}
			<option value="">{emptyLabel}</option>
		{/if}
		{#if orphan !== null}
			<option value={String(orphan)}>{orphan}: (no such step)</option>
		{/if}
		{#each options as opt (opt.index)}
			<option value={String(opt.index)}>{opt.label}</option>
		{/each}
	</select>
{:else}
	<input
		type="number"
		min="0"
		aria-label={ariaLabel}
		data-testid={testId}
		placeholder={emptyLabel ?? ''}
		class="w-24 rounded border border-input bg-card px-1 py-0.5 {extraClass}"
		value={value ?? ''}
		oninput={onType}
	/>
{/if}
