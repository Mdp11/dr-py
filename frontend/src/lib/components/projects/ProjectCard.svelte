<script lang="ts">
	import type { ProjectSummary } from '$lib/api/projects';
	import { deleteProject, cloneProject } from '$lib/api/projects';
	import { isAdmin } from '$lib/state';
	import { ApiError } from '$lib/api/errors';

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
	let error = $state<string | null>(null);

	async function onClone(): Promise<void> {
		error = null;
		busy = true;
		try {
			await cloneProject(project.id);
			onChanged();
		} catch (err) {
			error = err instanceof ApiError ? err.message : 'Something went wrong.';
		} finally {
			busy = false;
		}
	}

	async function onDelete(): Promise<void> {
		if (!window.confirm(`Delete project "${project.name}"? This cannot be undone.`)) return;
		error = null;
		busy = true;
		try {
			await deleteProject(project.id);
			onChanged();
		} catch (err) {
			error = err instanceof ApiError ? err.message : 'Something went wrong.';
		} finally {
			busy = false;
		}
	}
</script>

<div
	class="flex w-full flex-col rounded border border-zinc-800 bg-zinc-900 px-3 py-2 hover:border-zinc-700"
>
	<div class="flex w-full items-center justify-between">
		<button
			class="flex flex-1 items-center justify-between text-left"
			onclick={() => onOpen(project.id)}
			disabled={busy}
		>
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
	{#if error}<p class="text-xs text-red-400">{error}</p>{/if}
</div>
