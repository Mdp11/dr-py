<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Input } from '$lib/components/ui/input';
	import { Button } from '$lib/components/ui/button';
	import { clearAccessNotice, getAccessNotice, isAdmin } from '$lib/state';
	import { listProjects, type ProjectSummary } from '$lib/api/projects';
	import ProjectCard from '$lib/components/projects/ProjectCard.svelte';
	import NewProjectWizard from '$lib/components/projects/NewProjectWizard.svelte';

	// One-shot access-denied notice carried across a workspace → /projects bounce
	// (e.g. opening a project you are not a member of). Read once on mount and
	// cleared so a later refresh/navigation doesn't resurface a stale message.
	const accessNotice = getAccessNotice();
	onMount(() => clearAccessNotice());

	let projects = $state<ProjectSummary[]>([]);
	let query = $state('');
	let wizardOpen = $state(false);
	let loading = $state(true);
	let error = $state<string | null>(null);

	const filtered = $derived(
		projects.filter((p) => p.name.toLowerCase().includes(query.toLowerCase()))
	);

	async function refresh(): Promise<void> {
		loading = true;
		error = null;
		try {
			projects = await listProjects();
		} catch {
			error = 'Failed to load projects.';
		} finally {
			loading = false;
		}
	}
	onMount(refresh);

	function open(id: string): void {
		void goto(resolve(`/p/${id}`));
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
	{#if accessNotice}
		<p class="text-sm text-red-400" role="alert">{accessNotice}</p>
	{/if}
	<Input type="search" placeholder="Search projects…" bind:value={query} />
	<div class="flex flex-col gap-2">
		{#if loading}
			<p class="text-sm text-zinc-400">Loading…</p>
		{:else if error}
			<p class="text-sm text-red-400">{error}</p>
			<Button size="sm" variant="outline" onclick={refresh}>Retry</Button>
		{:else}
			{#each filtered as p (p.id)}
				<ProjectCard project={p} onOpen={open} />
			{:else}
				<p class="text-sm text-zinc-500">No projects.</p>
			{/each}
		{/if}
	</div>
</div>

{#if isAdmin()}
	<NewProjectWizard bind:open={wizardOpen} {onCreated} />
{/if}
