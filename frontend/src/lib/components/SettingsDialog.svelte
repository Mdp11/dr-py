<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { getSettings, updateSettings } from '$lib/api/settings';
	import { getRole, setStrictMode } from '$lib/state';

	type Props = { open: boolean };
	let { open = $bindable(false) }: Props = $props();

	const isOwner = $derived(getRole() === 'owner');

	let strictMode = $state(false);
	let loading = $state(false);
	let toggling = $state(false);
	let error = $state<string | null>(null);

	// Fetch current settings whenever the dialog opens.
	$effect(() => {
		if (!open) return;
		loading = true;
		error = null;
		getSettings()
			.then((res) => {
				strictMode = res.strict_mode;
			})
			.catch(() => {
				error = 'Failed to load settings.';
			})
			.finally(() => {
				loading = false;
			});
	});

	async function onToggle(): Promise<void> {
		if (!isOwner || toggling) return;
		const next = !strictMode;
		toggling = true;
		error = null;
		try {
			const res = await updateSettings(next);
			strictMode = res.strict_mode;
			setStrictMode(res.strict_mode);
		} catch {
			error = 'Failed to update settings.';
		} finally {
			toggling = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title>Settings</Dialog.Title>
		</Dialog.Header>

		<div class="flex flex-col gap-4 text-sm">
			{#if loading}
				<p class="text-zinc-400">Loading…</p>
			{:else}
				<div class="flex flex-col gap-2">
					<div class="flex items-center justify-between gap-4">
						<span class="text-zinc-200">Strict mode</span>
						<button
							role="switch"
							aria-checked={strictMode}
							aria-label="Strict mode"
							disabled={!isOwner || toggling}
							onclick={() => void onToggle()}
							class="relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 {strictMode
								? 'bg-indigo-600'
								: 'bg-zinc-700'}"
						>
							<span
								class="pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-lg ring-0 transition-transform {strictMode
									? 'translate-x-5'
									: 'translate-x-0.5'}"
							></span>
						</button>
					</div>
					<p class="text-xs text-zinc-400">
						When on, commits with validation errors are blocked (rebind is exempt).
					</p>
					{#if !isOwner}
						<p class="text-xs text-zinc-500">Only an owner can change this.</p>
					{/if}
					{#if error}
						<p class="rounded border border-red-900 bg-red-950/40 px-2 py-1.5 text-xs text-red-200">
							{error}
						</p>
					{/if}
				</div>
			{/if}
		</div>

		<Dialog.Footer>
			<Button variant="ghost" size="sm" onclick={() => (open = false)}>Close</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
