<script lang="ts">
	import '../app.css';
	import { QueryClient, QueryClientProvider } from '@tanstack/svelte-query';
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
</script>

<QueryClientProvider client={queryClient}>
	{@render children()}
	<CommandPalette />
</QueryClientProvider>
