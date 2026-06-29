<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button';
	import { getCurrentUser, isAdmin, signOut } from '$lib/state';

	const user = $derived(getCurrentUser());

	async function onLogout(): Promise<void> {
		await signOut();
		await goto(resolve('/login'));
	}
</script>

<header
	class="flex h-10 items-center justify-between border-b border-zinc-800 bg-zinc-950 px-3 text-sm"
>
	<div class="flex items-center gap-3">
		<button
			class="font-semibold tracking-tight text-zinc-100"
			onclick={() => goto(resolve('/projects'))}
		>
			Data Rover
		</button>
		{#if isAdmin()}
			<Button variant="ghost" size="sm" class="h-7 text-xs" onclick={() => goto(resolve('/admin'))}>
				Admin
			</Button>
		{/if}
	</div>
	<div class="flex items-center gap-2">
		<span class="text-xs text-zinc-400">{user?.email}</span>
		<Button variant="ghost" size="sm" class="h-7 text-xs" onclick={onLogout}>Sign out</Button>
	</div>
</header>
