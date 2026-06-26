<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import { isAdmin } from '$lib/state';
	import { listProjects, type ProjectSummary } from '$lib/api/projects';
	import ProjectCard from '$lib/components/projects/ProjectCard.svelte';
	import NewProjectWizard from '$lib/components/projects/NewProjectWizard.svelte';

	let projects = $state<ProjectSummary[]>([]);
	let query = $state('');
	let wizardOpen = $state(false);

	const filtered = $derived(
		projects.filter((p) => p.name.toLowerCase().includes(query.toLowerCase()))
	);

	async function refresh(): Promise<void> {
		projects = await listProjects();
	}
	onMount(refresh);

	function open(id: string): void {
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		void goto(`/p/${id}`);
	}
	async function onCreated(id: string): Promise<void> {
		wizardOpen = false;
		await refresh();
		open(id);
	}
</script>

<div class="mx-auto flex max-w-2xl flex-col gap-4 p-6">
	<div class="flex items-center justify-between">
		<h1 class="text-lg font-semibold text-zinc-100">Projects</h1>
		{#if isAdmin()}
			<Button size="sm" onclick={() => (wizardOpen = true)}>New project</Button>
		{/if}
	</div>
	<Input type="search" placeholder="Search projects…" bind:value={query} />
	<div class="flex flex-col gap-2">
		{#each filtered as p (p.id)}
			<ProjectCard project={p} onOpen={open} />
		{:else}
			<p class="text-sm text-zinc-500">No projects.</p>
		{/each}
	</div>
</div>

{#if isAdmin()}
	<NewProjectWizard bind:open={wizardOpen} {onCreated} />
{/if}
