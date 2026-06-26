<script lang="ts">
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { listUsers, createUser, patchUser, deleteUser, type AdminUser } from '$lib/api/admin';
	import { ApiError } from '$lib/api/errors';

	let users = $state<AdminUser[]>([]);
	let query = $state('');
	let email = $state('');
	let password = $state('');
	let makeAdmin = $state(false);
	let error = $state<string | null>(null);
	let busy = $state(false);

	function errMsg(err: unknown): string {
		return err instanceof ApiError ? err.message : 'Something went wrong.';
	}

	async function refresh(): Promise<void> {
		users = await listUsers(query);
	}
	onMount(refresh);

	async function onCreate(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		error = null;
		busy = true;
		try {
			await createUser({ email, password, is_admin: makeAdmin });
			email = '';
			password = '';
			makeAdmin = false;
			await refresh();
		} catch (err) {
			error =
				err instanceof ApiError ? err.message : 'Could not create user (email may already exist).';
		} finally {
			busy = false;
		}
	}

	async function toggleAdmin(u: AdminUser): Promise<void> {
		error = null;
		busy = true;
		try {
			await patchUser(u.id, { is_admin: !u.is_admin });
			await refresh();
		} catch (err) {
			error = errMsg(err);
		} finally {
			busy = false;
		}
	}
	async function toggleActive(u: AdminUser): Promise<void> {
		error = null;
		busy = true;
		try {
			await patchUser(u.id, { is_active: !u.is_active });
			await refresh();
		} catch (err) {
			error = errMsg(err);
		} finally {
			busy = false;
		}
	}
	async function remove(u: AdminUser): Promise<void> {
		error = null;
		busy = true;
		try {
			await deleteUser(u.id);
			await refresh();
		} catch (err) {
			error = errMsg(err);
		} finally {
			busy = false;
		}
	}
</script>

<div class="flex flex-col gap-4">
	<form data-testid="new-user-form" onsubmit={onCreate} class="flex items-end gap-2">
		<Input name="new-email" type="email" placeholder="Email" bind:value={email} required />
		<Input
			name="new-password"
			type="password"
			placeholder="Initial password"
			bind:value={password}
			required
		/>
		<label class="flex items-center gap-1 text-xs text-zinc-400">
			<input type="checkbox" bind:checked={makeAdmin} /> admin
		</label>
		<Button type="submit" size="sm" disabled={busy}>Add user</Button>
	</form>
	{#if error}<p class="text-xs text-red-400">{error}</p>{/if}

	<Input type="search" placeholder="Search users…" bind:value={query} oninput={refresh} />

	<ul class="flex w-full flex-col text-sm">
		{#each users as u (u.id)}
			<li class="flex items-center gap-2 border-b border-zinc-800 py-1">
				<span class="flex-1 text-zinc-100">{u.email}</span>
				<button class="text-xs text-zinc-400" onclick={() => toggleAdmin(u)} disabled={busy}>
					{u.is_admin ? 'admin' : 'user'}
				</button>
				<button class="text-xs text-zinc-400" onclick={() => toggleActive(u)} disabled={busy}>
					{u.is_active ? 'active' : 'disabled'}
				</button>
				<button class="text-xs text-red-400" onclick={() => remove(u)} disabled={busy}
					>delete</button
				>
			</li>
		{/each}
	</ul>
</div>
