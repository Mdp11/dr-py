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

	// Stale-response guard: each call to refresh() increments the counter and
	// captures the value at dispatch time; a response is discarded if a newer
	// request has already been dispatched.
	let _seq = 0;

	async function refresh(): Promise<void> {
		const seq = ++_seq;
		try {
			const result = await listUsers(query);
			if (seq !== _seq) return; // stale — a newer request supersedes this one
			users = result;
			error = null;
		} catch (err) {
			if (seq !== _seq) return;
			error = errMsg(err);
		}
	}
	onMount(refresh);

	// Debounce timer for search-driven refreshes. Mutations (create/toggle/
	// delete) call refresh() directly and are intentionally not debounced.
	let _searchTimer: ReturnType<typeof setTimeout> | null = null;

	function onSearchInput(): void {
		if (_searchTimer !== null) clearTimeout(_searchTimer);
		_searchTimer = setTimeout(() => {
			_searchTimer = null;
			void refresh();
		}, 250);
	}

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
		if (!window.confirm(`Delete user "${u.email}"? This cannot be undone.`)) return;
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
		<label class="flex items-center gap-1 text-xs text-muted-foreground">
			<input type="checkbox" bind:checked={makeAdmin} /> admin
		</label>
		<Button type="submit" size="sm" disabled={busy}>Add user</Button>
	</form>
	{#if error}<p class="text-xs text-destructive">{error}</p>{/if}

	<Input type="search" placeholder="Search users…" bind:value={query} oninput={onSearchInput} />

	<ul class="flex w-full flex-col text-sm">
		{#each users as u (u.id)}
			<li class="flex items-center gap-2 border-b border-border py-1">
				<span class="flex-1 text-foreground">{u.email}</span>
				<button
					class="text-xs text-muted-foreground"
					onclick={() => toggleAdmin(u)}
					disabled={busy}
				>
					{u.is_admin ? 'admin' : 'user'}
				</button>
				<button
					class="text-xs text-muted-foreground"
					onclick={() => toggleActive(u)}
					disabled={busy}
				>
					{u.is_active ? 'active' : 'disabled'}
				</button>
				<button class="text-xs text-destructive" onclick={() => remove(u)} disabled={busy}
					>delete</button
				>
			</li>
		{/each}
	</ul>
</div>
