<script lang="ts">
	import type { ProjectSummary } from '$lib/api/projects';
	let { project, onOpen }: { project: ProjectSummary; onOpen: (id: string) => void } = $props();
</script>

<button
	class="flex w-full items-center justify-between rounded border border-zinc-800 bg-zinc-900 px-3 py-2 text-left hover:border-zinc-700"
	onclick={() => onOpen(project.id)}
>
	<span class="text-sm text-zinc-100">{project.name}</span>
	<span class="text-xs text-zinc-400">{project.role}</span>
</button>
