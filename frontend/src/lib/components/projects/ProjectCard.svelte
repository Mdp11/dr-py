<script lang="ts">
	import type { ProjectSummary } from '$lib/api/projects';
	import { deleteProject, cloneProject } from '$lib/api/projects';
	import { isAdmin } from '$lib/state';

	let {
		project,
		onOpen,
		onChanged
	}: {
		project: ProjectSummary;
		onOpen: (id: string) => void;
		onChanged: () => void;
	} = $props();

	let busy = $state(false);

	async function onClone(): Promise<void> {
		busy = true;
		try {
			await cloneProject(project.id);
			onChanged();
		} finally {
			busy = false;
		}
	}

	async function onDelete(): Promise<void> {
		if (!window.confirm(`Delete project "${project.name}"? This cannot be undone.`)) return;
		busy = true;
		try {
			await deleteProject(project.id);
			onChanged();
		} finally {
			busy = false;
		}
	}
</script>

<div
	class="flex w-full items-center justify-between rounded border border-zinc-800 bg-zinc-900 px-3 py-2 hover:border-zinc-700"
>
	<button class="flex flex-1 items-center justify-between text-left" onclick={() => onOpen(project.id)}>
		<span class="text-sm text-zinc-100">{project.name}</span>
		<span class="ml-2 text-xs text-zinc-400">{project.role}</span>
	</button>
	<div class="ml-3 flex items-center gap-2">
		<button class="text-xs text-zinc-400 hover:text-zinc-100" onclick={onClone} disabled={busy}>
			Clone
		</button>
		{#if isAdmin()}
			<button class="text-xs text-red-400 hover:text-red-300" onclick={onDelete} disabled={busy}>
				Delete
			</button>
		{/if}
	</div>
</div>
