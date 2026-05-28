<script lang="ts">
	import { Separator } from '$lib/components/ui/separator';
</script>

<aside
	class="flex h-full flex-col overflow-hidden border-l border-zinc-800 bg-zinc-950 text-sm text-zinc-300"
>
	<section class="px-3 py-2">
		<h2 class="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Properties</h2>
		<p class="text-xs text-zinc-500">No element selected.</p>
	</section>
	<Separator class="bg-zinc-800" />
	<section class="px-3 py-2">
		<h2 class="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
			Incoming relationships
		</h2>
		<p class="font-mono text-xs text-zinc-500">—</p>
	</section>
	<Separator class="bg-zinc-800" />
	<section class="flex-1 overflow-auto px-3 py-2">
		<h2 class="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
			Outgoing relationships
		</h2>
		<p class="font-mono text-xs text-zinc-500">—</p>
	</section>
</aside>
