<script lang="ts">
	import '../app.css';
	import { page } from '$app/stores';
	import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';
	import AppHeader from '$lib/components/AppHeader.svelte';
	import CommandPalette from '$lib/components/CommandPalette.svelte';
	import ProgressOverlay from '$lib/components/ProgressOverlay.svelte';
	import { installKeyboardShortcuts } from '$lib/keyboard.svelte';
	import { installSessionRecovery } from '$lib/state/session-recovery';

	let { children } = $props();

	// Register the global mid-session 401 handler once for the whole app. The root
	// layout mounts exactly once in this SPA, so this runs a single time; the
	// handler self-gates on a logged-in user (no-op otherwise).
	installSessionRecovery();

	const queryClient = new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: 30_000,
				refetchOnWindowFocus: false
			}
		}
	});

	$effect(() => {
		return installKeyboardShortcuts();
	});

	const showHeader = $derived(
		!$page.url.pathname.startsWith('/p/') && ($page.url.pathname as string) !== '/login'
	);
</script>

<QueryClientProvider client={queryClient}>
	{#if showHeader}
		<AppHeader />
	{/if}
	{@render children()}
	<CommandPalette />
	<ProgressOverlay />
</QueryClientProvider>
