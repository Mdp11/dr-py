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
	import ResultsPanel from '$lib/components/ResultsPanel.svelte';
	import { maybeAutoload } from '$lib/autoload';
	import { metamodel as metamodelApi } from '$lib/api';
	import {
		clearModelError,
		clearSelection,
		getDiffDrawerOpen,
		getModelError,
		getResultsPanelOpen,
		refreshSummary,
		refreshView,
		resetModelStore,
		setDiffDrawerOpen,
		setMetamodel
	} from '$lib/state';

	onMount(() => {
		void boot();
	});

	// App boot: dev autoload first (it installs metamodel + model when
	// configured), then adopt whatever session the backend already holds — a
	// page reload mid-session should come back with the model, not a blank
	// workspace.
	async function boot(): Promise<void> {
		await maybeAutoload();
		try {
			setMetamodel(await metamodelApi.getMetamodel());
		} catch {
			return; // no metamodel session-side: nothing else can be loaded
		}
		try {
			await refreshSummary();
		} catch {
			return; // metamodel but no model
		}
		await refreshView();
	}

	// Conflict / flush-error banner. A conflict means the local caches are
	// divergent from the session model; the only safe recovery is a reload
	// (reset + refetch). Rejected/transport errors are dismissable.
	const modelError = $derived(getModelError());

	let reloading = $state(false);

	async function onReloadModel(): Promise<void> {
		if (reloading) return;
		reloading = true;
		try {
			resetModelStore();
			clearSelection();
			await refreshSummary();
			await refreshView();
		} catch (err) {
			console.error('Model reload failed', err);
		} finally {
			reloading = false;
		}
	}

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

	const LS_PANEL = 'ui.resultsPanelHeight';
	const DEFAULT_PANEL = 240;
	const PANEL_MIN = 120;
	const PANEL_MAX = 700;
	// Clamp the persisted value to the handle's range, in case a stale/legacy
	// localStorage entry falls outside [PANEL_MIN, PANEL_MAX].
	let panelHeight = $state(
		Math.min(PANEL_MAX, Math.max(PANEL_MIN, readWidth(LS_PANEL, DEFAULT_PANEL)))
	);
	const panelOpen = $derived(getResultsPanelOpen());

	$effect(() => {
		if (browser) localStorage.setItem(LS_PANEL, String(panelHeight));
	});

	const cols = $derived(`${leftWidth}px 4px 1fr 4px ${rightWidth}px`);
	// extra `auto` row when the error banner is shown (it spans all columns)
	const rows = $derived.by(() => {
		const banner = modelError !== null ? 'auto ' : '';
		return panelOpen ? `auto ${banner}1fr auto ${panelHeight}px auto` : `auto ${banner}1fr auto`;
	});
</script>

<div
	class="grid h-screen w-screen overflow-hidden bg-zinc-950 text-zinc-100"
	style:grid-template-columns={cols}
	style:grid-template-rows={rows}
>
	<TopBar />
	{#if modelError !== null}
		<div
			class="col-span-5 flex items-center gap-3 border-b border-red-900 bg-red-950/60 px-3 py-1.5 text-xs text-red-200"
			role="alert"
		>
			<span class="font-semibold uppercase tracking-wide">
				{modelError.kind === 'conflict' ? 'Model out of sync' : 'Edit rejected'}
			</span>
			<span class="truncate">{modelError.message}</span>
			<div class="ml-auto flex items-center gap-2">
				{#if modelError.kind === 'conflict'}
					<button
						type="button"
						class="rounded border border-red-700 bg-red-900/60 px-2 py-0.5 hover:bg-red-900"
						disabled={reloading}
						onclick={() => void onReloadModel()}
					>
						{reloading ? 'Reloading…' : 'Reload model'}
					</button>
				{:else}
					<button
						type="button"
						class="rounded border border-red-700 bg-red-900/60 px-2 py-0.5 hover:bg-red-900"
						onclick={() => clearModelError()}
					>
						Dismiss
					</button>
				{/if}
			</div>
		</div>
	{/if}
	<Sidebar />
	<ResizeHandle value={leftWidth} side="left" onchange={(n) => (leftWidth = n)} />
	<Workspace />
	<ResizeHandle value={rightWidth} side="right" onchange={(n) => (rightWidth = n)} />
	<Inspector />
	{#if panelOpen}
		<div class="col-span-5">
			<ResizeHandle
				value={panelHeight}
				axis="y"
				min={PANEL_MIN}
				max={PANEL_MAX}
				onchange={(n) => (panelHeight = n)}
			/>
		</div>
		<ResultsPanel />
	{/if}
	<StatusBar />
</div>

<DiffDrawer bind:open={drawerOpen} />
