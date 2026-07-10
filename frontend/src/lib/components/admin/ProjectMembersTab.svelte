<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { listProjects, type ProjectSummary } from '$lib/api/projects';
	import {
		listMembers,
		addMember,
		removeMember,
		listUsers,
		type Member,
		type AdminUser
	} from '$lib/api/admin';
	import { ApiError } from '$lib/api/errors';

	let projects = $state<ProjectSummary[]>([]);
	let selected = $state<string>('');
	let members = $state<Member[]>([]);
	let newRole = $state<Member['role']>('editor');
	let error = $state<string | null>(null);
	let busy = $state(false);

	let userQuery = $state('');
	let userResults = $state<AdminUser[]>([]);
	let selectedUser = $state<AdminUser | null>(null);
	let _searchTimer: ReturnType<typeof setTimeout> | null = null;

	function errMsg(err: unknown): string {
		return err instanceof ApiError ? err.message : 'Something went wrong.';
	}

	function onUserSearch(): void {
		selectedUser = null;
		if (_searchTimer !== null) clearTimeout(_searchTimer);
		_searchTimer = setTimeout(async () => {
			_searchTimer = null;
			try {
				userResults = await listUsers(userQuery);
			} catch (err) {
				error = errMsg(err);
			}
		}, 250);
	}

	function pickUser(u: AdminUser): void {
		selectedUser = u;
		userQuery = u.email;
		userResults = [];
	}

	onMount(async () => {
		try {
			projects = await listProjects();
			if (projects.length) await select(projects[0].id);
		} catch (err) {
			error = errMsg(err);
		}
	});

	onDestroy(() => {
		if (_searchTimer !== null) clearTimeout(_searchTimer);
	});

	async function select(id: string): Promise<void> {
		selected = id;
		error = null;
		busy = true;
		try {
			members = await listMembers(id);
		} catch (err) {
			error = errMsg(err);
		} finally {
			busy = false;
		}
	}
	async function add(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		if (!selectedUser) {
			error = 'Pick a user from the search results first.';
			return;
		}
		error = null;
		busy = true;
		try {
			await addMember(selected, selectedUser.id, newRole);
			userQuery = '';
			selectedUser = null;
			userResults = [];
			members = await listMembers(selected);
		} catch (err) {
			error = errMsg(err);
		} finally {
			busy = false;
		}
	}
	async function remove(userId: string): Promise<void> {
		if (!window.confirm('Remove this member from the project?')) return;
		error = null;
		busy = true;
		try {
			await removeMember(selected, userId);
			members = await listMembers(selected);
		} catch (err) {
			error = errMsg(err);
		} finally {
			busy = false;
		}
	}
</script>

<div class="flex flex-col gap-3">
	<select
		class="rounded bg-card px-2 py-1 text-sm text-foreground"
		bind:value={selected}
		onchange={() => select(selected)}
	>
		{#each projects as p (p.id)}
			<option value={p.id}>{p.name}</option>
		{/each}
	</select>

	<form onsubmit={add} class="flex flex-col gap-1">
		<div class="flex items-end gap-2">
			<div class="relative flex-1">
				<Input placeholder="Search user by email…" bind:value={userQuery} oninput={onUserSearch} />
				{#if userResults.length}
					<ul class="absolute z-10 mt-1 w-full rounded border border-border bg-popover">
						{#each userResults as u (u.id)}
							<li>
								<button
									type="button"
									class="block w-full px-2 py-1 text-left text-sm text-foreground hover:bg-muted"
									onclick={() => pickUser(u)}
								>
									{u.email}
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
			<select class="rounded bg-card px-2 py-1 text-sm text-foreground" bind:value={newRole}>
				<option value="owner">owner</option>
				<option value="editor">editor</option>
				<option value="viewer">viewer</option>
			</select>
			<Button type="submit" size="sm" disabled={busy || !selectedUser}>Add member</Button>
		</div>
	</form>

	{#if error}<p class="text-xs text-destructive">{error}</p>{/if}

	<ul class="flex flex-col gap-1">
		{#each members as m (m.user_id)}
			<li class="flex items-center justify-between text-sm">
				<span class="text-foreground"
					>{m.email} <span class="text-muted-foreground/70">({m.role})</span></span
				>
				<button class="text-xs text-destructive" onclick={() => remove(m.user_id)} disabled={busy}
					>remove</button
				>
			</li>
		{/each}
	</ul>
</div>
