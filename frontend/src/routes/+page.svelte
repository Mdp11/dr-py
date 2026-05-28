<script lang="ts">
	import { browser } from '$app/environment';
	import { onMount } from 'svelte';
	import TopBar from '$lib/components/TopBar.svelte';
	import StatusBar from '$lib/components/StatusBar.svelte';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import Workspace from '$lib/components/Workspace.svelte';
	import Inspector from '$lib/components/Inspector.svelte';
	import DiffDrawer from '$lib/components/DiffDrawer.svelte';
	import ResizeHandle from '$lib/components/ResizeHandle.svelte';
	import { maybeAutoload } from '$lib/autoload';
	import { getDiffDrawerOpen, setDiffDrawerOpen } from '$lib/state';

	onMount(() => {
		void maybeAutoload();
	});

	// Local bindable mirror of the global ui store so DiffDrawer's existing
	// `bind:open` contract keeps working. Writable $derived: it tracks the
	// store, and DiffDrawer's `bind:open` can override it until the store
	// changes again; the effect pushes any local override back to the store.
	let drawerOpen = $derived(getDiffDrawerOpen());

	$effect(() => {
		if (drawerOpen !== getDiffDrawerOpen()) setDiffDrawerOpen(drawerOpen);
	});

	const LS_LEFT = 'ui.sidebarWidth';
	const LS_RIGHT = 'ui.inspectorWidth';
	const DEFAULT_LEFT = 256; // 16rem
	const DEFAULT_RIGHT = 352; // 22rem

	function readWidth(key: string, fallback: number) {
		if (!browser) return fallback;
		const raw = localStorage.getItem(key);
		const n = raw == null ? NaN : Number(raw);
		return Number.isFinite(n) && n > 0 ? n : fallback;
	}

	let leftWidth = $state(readWidth(LS_LEFT, DEFAULT_LEFT));
	let rightWidth = $state(readWidth(LS_RIGHT, DEFAULT_RIGHT));

	$effect(() => {
		if (browser) localStorage.setItem(LS_LEFT, String(leftWidth));
	});
	$effect(() => {
		if (browser) localStorage.setItem(LS_RIGHT, String(rightWidth));
	});

	const cols = $derived(`${leftWidth}px 4px 1fr 4px ${rightWidth}px`);
</script>

<div
	class="grid h-screen w-screen grid-rows-[auto_1fr_auto] overflow-hidden bg-zinc-950 text-zinc-100"
	style:grid-template-columns={cols}
>
	<TopBar />
	<Sidebar />
	<ResizeHandle value={leftWidth} side="left" onchange={(n) => (leftWidth = n)} />
	<Workspace />
	<ResizeHandle value={rightWidth} side="right" onchange={(n) => (rightWidth = n)} />
	<Inspector />
	<StatusBar />
</div>

<DiffDrawer bind:open={drawerOpen} />
