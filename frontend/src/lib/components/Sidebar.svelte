<script lang="ts">
	import { Separator } from '$lib/components/ui/separator';
</script>

<aside
	class="flex h-full flex-col overflow-hidden border-r border-zinc-800 bg-zinc-950 text-sm text-zinc-300"
>
	<section class="px-3 py-2">
		<h2 class="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Search</h2>
		<p class="text-xs text-zinc-500">Filter by name, type, id…</p>
	</section>
	<Separator class="bg-zinc-800" />
	<section class="flex-1 overflow-auto px-3 py-2">
		<h2 class="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Tree</h2>
		<p class="text-xs text-zinc-500">Containment tree placeholder.</p>
	</section>
	<Separator class="bg-zinc-800" />
	<section class="px-3 py-2">
		<h2 class="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Types</h2>
		<p class="text-xs text-zinc-500">Type filters placeholder.</p>
	</section>
</aside>
