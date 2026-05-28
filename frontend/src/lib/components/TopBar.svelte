<script lang="ts">
	import { Button } from '$lib/components/ui/button';
</script>

<header
	class="sticky top-0 z-20 col-span-3 flex h-10 items-center justify-between border-b border-zinc-800 bg-zinc-950 px-3 text-sm"
>
	<div class="flex items-center gap-2">
		<span class="font-semibold tracking-tight text-zinc-100">Data Rover</span>
	</div>
	<div class="flex items-center gap-2">
		<Button variant="ghost" size="sm" class="h-7 text-xs">Validate</Button>
		<Button variant="ghost" size="sm" class="h-7 text-xs">Save</Button>
		<span class="font-mono text-xs text-zinc-400">● 0 changes</span>
	</div>
</header>
