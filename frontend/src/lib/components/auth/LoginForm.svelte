<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
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
		await goto(resolve('/projects'));
	}
</script>

<form
	onsubmit={onSubmit}
	class="flex w-80 flex-col gap-4 rounded-lg border border-border bg-card/70 p-8"
>
	<h1 class="font-display text-lg font-light tracking-wide text-foreground">Sign in</h1>
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
		<p class="text-xs text-destructive">{error}</p>
	{/if}
	<Button type="submit" disabled={pending}>{pending ? 'Signing in…' : 'Sign in'}</Button>
</form>
