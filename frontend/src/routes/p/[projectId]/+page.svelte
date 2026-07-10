<script lang="ts">
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { onDestroy, onMount } from 'svelte';
	import { slide } from 'svelte/transition';
	import { dur, PANEL } from '$lib/util/motion';
	import TopBar from '$lib/components/TopBar.svelte';
	import StatusBar from '$lib/components/StatusBar.svelte';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import Workspace from '$lib/components/Workspace.svelte';
	import Inspector from '$lib/components/Inspector.svelte';
	import DiffDrawer from '$lib/components/DiffDrawer.svelte';
	import HistoryDrawer from '$lib/components/HistoryDrawer.svelte';
	import ResizeHandle from '$lib/components/ResizeHandle.svelte';
	import ResultsPanel from '$lib/components/ResultsPanel.svelte';
	import { metamodel as metamodelApi } from '$lib/api';
	import { Button } from '$lib/components/ui/button';
	import {
		getFeedTermination,
		getPendingRebind,
		clearPendingRebind
	} from '$lib/state/realtime.svelte';
	import { recoverFromUnauthorized } from '$lib/state/session-recovery';
	import { getMetamodel as fetchMetamodel } from '$lib/api/metamodel';
	import { runValidation } from '$lib/state/validate-action';
	import {
		cancelOpenProgress,
		clearModelError,
		clearSelection,
		getActiveProjectId,
		reactToBootError,
		setAccessNotice,
		getDiffDrawerOpen,
		getHistoryDrawerOpen,
		getModelError,
		getResultsPanelOpen,
		handleRemoteLockEvent,
		initWorkspaceTabs,
		loadArtifacts,
		loadProjectInfo,
		markViewUnresolved,
		onLockEvent,
		refreshSummary,
		refreshView,
		resetArtifacts,
		resetCheckout,
		resetModelStore,
		setDiffDrawerOpen,
		setHistoryDrawerOpen,
		setMetamodel,
		setProjectOpening,
		startRealtime,
		stopRealtime,
		trackOpenProgress
	} from '$lib/state';

	onMount(() => startRealtime());
	onMount(() => onLockEvent((action, leases) => handleRemoteLockEvent(action, leases)));
	onMount(() => {
		// setActiveProject(params.projectId) already ran in +layout.ts's load,
		// so the active id is set before this mount fires.
		const pid = getActiveProjectId();
		if (pid) initWorkspaceTabs(pid);
	});
	onMount(() => {
		void boot();
	});
	onDestroy(() => stopRealtime());
	onDestroy(() => cancelOpenProgress());

	// App boot: adopt whatever session the backend already holds for this
	// project — a page reload mid-session should come back with the model, not a
	// blank workspace. Project content is established server-side (the seeded
	// `default` project or a project created via the New Project wizard), not by
	// any client-side file autoload. The view must resolve BEFORE the summary
	// (which flips the containment tree's `hasModel` gate) so the tree's first
	// paint is already view-shaped instead of flashing all elements and then
	// collapsing to the view a beat later.
	async function boot(): Promise<void> {
		// Warm opens never show the open-progress overlay (status is 'ready'
		// immediately), so this flag is what keeps the containment tree on a
		// skeleton instead of flashing its empty states while the loads below run.
		setProjectOpening(true);
		try {
			void trackOpenProgress(); // fire-and-forget: overlay while the requests below hydrate the session
			markViewUnresolved(); // reset the view-answered gate on every project (re)entry
			try {
				setMetamodel(await metamodelApi.getMetamodel());
			} catch (err) {
				// A 403 means we are NOT a member of this project (an admin sees every
				// project in the picker, but require_membership 403s on open): set an
				// access notice and bounce to /projects rather than silently showing a
				// blank workspace. A 404 ("No metamodel loaded") for a legitimately empty
				// project — or any other error — falls through to the best-effort return
				// below (nothing else can be loaded yet).
				reactToBootError(err, {
					setNotice: setAccessNotice,
					navigate: () => void goto(resolve('/projects'))
				});
				cancelOpenProgress(); // a failed boot must tear the open-progress overlay down
				return;
			}
			await refreshView();
			try {
				await refreshSummary();
			} catch {
				return; // metamodel but no model
			}
			try {
				await loadProjectInfo();
			} catch {
				// role/ttl best-effort; editing stays gated as viewer until it loads
			}
			await loadArtifacts().catch(() => {}); // artifact library is best-effort
		} finally {
			setProjectOpening(false);
		}
	}

	// Conflict / flush-error banner. A conflict means the local caches are
	// divergent from the session model; the only safe recovery is a reload
	// (reset + refetch). Rejected/transport errors are dismissable.
	const modelError = $derived(getModelError());

	// Peer-rebind banner: shown when another user swapped the metamodel while
	// this session was open. The user must reload to pick up the new metamodel.
	const pendingRebind = $derived(getPendingRebind());

	// Feed-termination banner: the realtime feed was permanently closed by the
	// server (the transport stopped reconnecting). Each terminal code gets a
	// context-appropriate message + action. 4401 reuses the mid-session 401
	// recovery (clear session → /login); 4403/4404 bounce to the project picker.
	const feedTermination = $derived(getFeedTermination());
	const feedTerminationView = $derived.by(() => {
		const code = feedTermination?.code;
		if (code === 4401)
			return {
				message: 'Your session expired.',
				label: 'Sign in',
				action: () => void recoverFromUnauthorized()
			};
		if (code === 4403)
			return {
				message: 'You are no longer a member of this project.',
				label: 'Go to projects',
				action: () => void goto(resolve('/projects'))
			};
		if (code === 4404)
			return {
				message: 'This project no longer exists.',
				label: 'Go to projects',
				action: () => void goto(resolve('/projects'))
			};
		// Any other terminal code (e.g. 4408 dropped-behind after repeated retries)
		// → generic "connection lost" banner with a page-reload affordance.
		if (code !== undefined)
			return {
				message: 'Realtime connection lost.',
				label: 'Reload',
				action: () => location.reload()
			};
		return null;
	});

	// Rebind is non-destructive: only the metamodel pointer and conformance issues change;
	// element ids and properties are untouched, so the cached element subset stays valid.
	// Unlike onReloadModel, we do NOT reset the model store — only the metamodel, issues, and rev.
	async function onReloadRebind(): Promise<void> {
		const mm = await fetchMetamodel();
		setMetamodel(mm);
		await refreshSummary();
		await runValidation();
		clearPendingRebind();
	}

	let reloading = $state(false);

	async function onReloadModel(): Promise<void> {
		if (reloading) return;
		reloading = true;
		setProjectOpening(true); // same tree-skeleton gate as boot(): the resets below blank the tree
		try {
			resetModelStore();
			resetCheckout();
			resetArtifacts();
			clearSelection();
			// refreshView() runs before refreshSummary() (mirroring boot()'s order)
			// so the tree's first paint after a reload is view-shaped rather than
			// briefly rendering against the stale pre-reload view. We deliberately
			// do NOT call markViewUnresolved() here: unresolving is unnecessary on
			// reload — the prior session's view is still the active view, and
			// because refreshView() is awaited before refreshSummary() below, the
			// first repaint is already view-shaped. Only boot() (a fresh project
			// entry, where the view may legitimately change) needs to re-arm the
			// unresolved gate.
			await refreshView();
			await refreshSummary();
			try {
				// resetCheckout() reset the role to 'viewer'; re-adopt role + lock TTL
				// from /open (mirrors boot()'s placement after refreshSummary), best-
				// effort so a failure doesn't break the reload. Without this, an in-app
				// reload leaves the user stuck view-only until a full browser refresh.
				await loadProjectInfo();
			} catch {
				// role/ttl best-effort; editing stays gated as viewer until it loads
			}
			await loadArtifacts().catch(() => {}); // artifact library is best-effort
		} catch (err) {
			console.error('Model reload failed', err);
		} finally {
			reloading = false;
			setProjectOpening(false);
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

	let historyOpen = $derived(getHistoryDrawerOpen());

	$effect(() => {
		if (historyOpen !== getHistoryDrawerOpen()) setHistoryDrawerOpen(historyOpen);
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
	// extra `auto` rows when error/rebind banners are shown (each spans all columns)
	const rows = $derived.by(() => {
		const errorBanner = modelError !== null ? 'auto ' : '';
		const rebindBanner = pendingRebind !== null ? 'auto ' : '';
		const feedBanner = feedTerminationView !== null ? 'auto ' : '';
		return panelOpen
			? `auto ${errorBanner}${rebindBanner}${feedBanner}1fr auto ${panelHeight}px auto`
			: `auto ${errorBanner}${rebindBanner}${feedBanner}1fr auto`;
	});
</script>

<div
	class="grid h-screen w-screen overflow-hidden bg-background text-foreground"
	style:grid-template-columns={cols}
	style:grid-template-rows={rows}
>
	<TopBar />
	{#if modelError !== null}
		<div
			class="col-span-5 flex items-center gap-3 border-b border-destructive/40 bg-destructive/15 px-3 py-1.5 text-xs text-destructive"
			role="alert"
			transition:slide={{ duration: dur(PANEL) }}
		>
			<span class="font-semibold uppercase tracking-wide">
				{modelError.kind === 'conflict' ? 'Model out of sync' : 'Edit rejected'}
			</span>
			<span class="truncate">{modelError.message}</span>
			<div class="ml-auto flex items-center gap-2">
				{#if modelError.kind === 'conflict'}
					<button
						type="button"
						class="rounded border border-destructive/40 bg-destructive/15 px-2 py-0.5 transition-colors hover:bg-destructive/25"
						disabled={reloading}
						onclick={() => void onReloadModel()}
					>
						{reloading ? 'Reloading…' : 'Reload model'}
					</button>
				{:else}
					<button
						type="button"
						class="rounded border border-destructive/40 bg-destructive/15 px-2 py-0.5 transition-colors hover:bg-destructive/25"
						onclick={() => clearModelError()}
					>
						Dismiss
					</button>
				{/if}
			</div>
		</div>
	{/if}
	{#if pendingRebind}
		<div
			class="col-span-5 flex items-center justify-between gap-3 bg-warning/15 px-3 py-1.5 text-xs text-warning"
			role="alert"
			transition:slide={{ duration: dur(PANEL) }}
		>
			<span>
				The metamodel was changed to rev {pendingRebind.rev} ({pendingRebind.count} conformance issues).
				Reload to continue.
			</span>
			<Button size="sm" variant="ghost" class="h-6 text-xs" onclick={() => void onReloadRebind()}>
				Reload
			</Button>
		</div>
	{/if}
	{#if feedTerminationView}
		<div
			class="col-span-5 flex items-center gap-3 border-b border-destructive/40 bg-destructive/15 px-3 py-1.5 text-xs text-destructive"
			role="alert"
			transition:slide={{ duration: dur(PANEL) }}
		>
			<span class="font-semibold uppercase tracking-wide">Disconnected</span>
			<span class="truncate">{feedTerminationView.message}</span>
			<div class="ml-auto flex items-center gap-2">
				<button
					type="button"
					class="rounded border border-destructive/40 bg-destructive/15 px-2 py-0.5 transition-colors hover:bg-destructive/25"
					onclick={feedTerminationView.action}
				>
					{feedTerminationView.label}
				</button>
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
<HistoryDrawer bind:open={historyOpen} />
