<script lang="ts">
	import TopBar from '$lib/components/TopBar.svelte';
	import StatusBar from '$lib/components/StatusBar.svelte';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import Workspace from '$lib/components/Workspace.svelte';
	import Inspector from '$lib/components/Inspector.svelte';
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
