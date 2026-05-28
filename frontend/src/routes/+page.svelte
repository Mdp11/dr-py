<script lang="ts">
	import TopBar from '$lib/components/TopBar.svelte';
	import StatusBar from '$lib/components/StatusBar.svelte';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import Workspace from '$lib/components/Workspace.svelte';
	import Inspector from '$lib/components/Inspector.svelte';
	import DiffDrawer from '$lib/components/DiffDrawer.svelte';
	import { getDiffDrawerOpen, setDiffDrawerOpen } from '$lib/state';

	// Local bindable mirror of the global ui store so DiffDrawer's existing
	// `bind:open` contract keeps working.
	let drawerOpen = $state(false);

	$effect(() => {
		drawerOpen = getDiffDrawerOpen();
	});
	$effect(() => {
		if (drawerOpen !== getDiffDrawerOpen()) setDiffDrawerOpen(drawerOpen);
	});
</script>

<div
	class="grid h-screen w-screen grid-cols-[16rem_1fr_22rem] grid-rows-[auto_1fr_auto] overflow-hidden bg-zinc-950 text-zinc-100"
>
	<TopBar />
	<Sidebar />
	<Workspace />
	<Inspector />
	<StatusBar />
</div>

<DiffDrawer bind:open={drawerOpen} />
