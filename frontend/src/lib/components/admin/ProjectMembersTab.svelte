<script lang="ts">
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { listProjects, type ProjectSummary } from '$lib/api/projects';
	import { listMembers, addMember, removeMember, type Member } from '$lib/api/admin';

	let projects = $state<ProjectSummary[]>([]);
	let selected = $state<string>('');
	let members = $state<Member[]>([]);
	let newUserId = $state('');
	let newRole = $state<Member['role']>('editor');

	onMount(async () => {
		projects = await listProjects();
		if (projects.length) await select(projects[0].id);
	});

	async function select(id: string): Promise<void> {
		selected = id;
		members = await listMembers(id);
	}
	async function add(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		await addMember(selected, newUserId, newRole);
		newUserId = '';
		members = await listMembers(selected);
	}
	async function remove(userId: string): Promise<void> {
		await removeMember(selected, userId);
		members = await listMembers(selected);
	}
</script>

<div class="flex flex-col gap-3">
	<select
		class="rounded bg-zinc-900 px-2 py-1 text-sm text-zinc-100"
		bind:value={selected}
		onchange={() => select(selected)}
	>
		{#each projects as p (p.id)}
			<option value={p.id}>{p.name}</option>
		{/each}
	</select>

	<form onsubmit={add} class="flex items-end gap-2">
		<Input placeholder="User id" bind:value={newUserId} required />
		<select class="rounded bg-zinc-900 px-2 py-1 text-sm text-zinc-100" bind:value={newRole}>
			<option value="owner">owner</option>
			<option value="editor">editor</option>
			<option value="viewer">viewer</option>
		</select>
		<Button type="submit" size="sm">Add member</Button>
	</form>

	<ul class="flex flex-col gap-1">
		{#each members as m (m.user_id)}
			<li class="flex items-center justify-between text-sm">
				<span class="text-zinc-100">{m.email} <span class="text-zinc-500">({m.role})</span></span>
				<button class="text-xs text-red-400" onclick={() => remove(m.user_id)}>remove</button>
			</li>
		{/each}
	</ul>
</div>
