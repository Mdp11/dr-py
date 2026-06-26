<script lang="ts">
	import { goto } from '$app/navigation';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { signIn } from '$lib/state';

	let email = $state('');
	let password = $state('');
	let error = $state<string | null>(null);
	let pending = $state(false);

	async function onSubmit(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		error = null;
		pending = true;
		try {
			await signIn(email, password);
		} catch {
			error = 'Invalid email or password.';
			return;
		} finally {
			pending = false;
		}
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		await goto('/projects');
	}
</script>

<form onsubmit={onSubmit} class="flex w-72 flex-col gap-3">
	<h1 class="text-base font-semibold text-zinc-100">Sign in</h1>
	<Input
		type="email"
		placeholder="Email"
		autocomplete="username"
		aria-label="Email"
		bind:value={email}
		required
	/>
	<Input
		type="password"
		placeholder="Password"
		autocomplete="current-password"
		aria-label="Password"
		bind:value={password}
		required
	/>
	{#if error}
		<p class="text-xs text-red-400">{error}</p>
	{/if}
	<Button type="submit" disabled={pending}>{pending ? 'Signing in…' : 'Sign in'}</Button>
</form>
