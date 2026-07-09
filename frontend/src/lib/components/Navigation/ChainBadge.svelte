<script lang="ts">
	// The circled mono digit that teaches the chain-column concept. It appears
	// in exactly three places — the editor rail, the results-table headers, and
	// the "→ feeds" popover — all fed by `chainColumns`. A null value renders
	// the ghost dot used by filter rows (they add no column, so no number).
	// Plain digits inside a styled circle, never the unicode circled glyphs
	// (⓪①②), which render as tofu in some fonts.
	let {
		value,
		tone = 'default',
		size = 'md'
	}: {
		value: number | null;
		tone?: 'default' | 'start' | 'combine';
		size?: 'sm' | 'md';
	} = $props();
</script>

<span
	data-testid="chain-badge"
	class="inline-flex flex-none items-center justify-center rounded-full border font-mono
		{size === 'sm' ? 'size-[15px] text-[9px]' : 'size-5 text-[10px]'}
		{value === null
		? 'border-transparent bg-transparent text-zinc-500'
		: tone === 'start'
			? 'border-emerald-800 bg-zinc-900 text-emerald-400'
			: tone === 'combine'
				? 'border-indigo-400/35 bg-zinc-950 text-indigo-400'
				: 'border-zinc-700 bg-zinc-900 text-zinc-400'}"
>
	{value === null ? '·' : value}
</span>
