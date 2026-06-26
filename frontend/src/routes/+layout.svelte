<script lang="ts">
	import '../app.css';
	import { page } from '$app/stores';
	import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';
	import AppHeader from '$lib/components/AppHeader.svelte';
	import CommandPalette from '$lib/components/CommandPalette.svelte';
	import { installKeyboardShortcuts } from '$lib/keyboard.svelte';

	let { children } = $props();

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
</QueryClientProvider>
