<script lang="ts">
	import { goto } from '$app/navigation';
	import { assets, resolve } from '$app/paths';
	import { Button } from '$lib/components/ui/button';
	import { getCurrentUser, isAdmin, signOut } from '$lib/state';

	const user = $derived(getCurrentUser());

	async function onLogout(): Promise<void> {
		await signOut();
		await goto(resolve('/login'));
	}
</script>

<header
	class="flex h-11 items-center justify-between border-b border-border bg-background px-4 text-sm"
>
	<div class="flex items-center gap-4">
		<button
			class="flex items-center focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
			aria-label="Data Rover"
			onclick={() => goto(resolve('/projects'))}
		>
			<img src={`${assets}/dr-mark.png`} alt="" class="h-6 w-auto" />
		</button>
		{#if isAdmin()}
			<Button variant="ghost" size="sm" class="h-7 text-xs" onclick={() => goto(resolve('/admin'))}>
				Admin
			</Button>
		{/if}
	</div>
	<div class="flex items-center gap-3">
		<kbd
			class="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/70"
			title="Command palette">⌘K</kbd
		>
		<span class="text-xs text-muted-foreground">{user?.email}</span>
		<Button variant="ghost" size="sm" class="h-7 text-xs" onclick={onLogout}>Sign out</Button>
	</div>
</header>
