<script lang="ts">
	import { browser } from '$app/environment';
	import { beforeNavigate, goto } from '$app/navigation';
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
	import { hasUnsavedWork } from '$lib/state/unsaved';
	import {
		beginJourney,
		cancelJourney,
		cancelOpenProgress,
		clearModelError,
		clearOverlay,
		clearSelection,
		clearViewState,
		closeMetamodelStage,
		finishJourney,
		getActiveProjectId,
		reactToBootError,
		setAccessNotice,
		getDiffDrawerOpen,
		getHistoryDrawerOpen,
		getModelError,
		getResultsPanelOpen,
		getViewDiscardNotice,
		clearViewDiscardNotice,
		handleRemoteLockEvent,
		initWorkspaceTabs,
		loadArtifacts,
		loadProjectInfo,
		markViewUnresolved,
		onLockEvent,
		refetchIssues,
		refreshSummary,
		refreshView,
		resetArtifacts,
		resetCheckout,
		resetInspectionHistory,
		resetModelStore,
		resetSnippetEditors,
		resetSnippetDocs,
		resetViewEdits,
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
		// The visit trail is per-project and in-memory: opening a project
		// (including switching projects) starts it fresh.
		resetInspectionHistory();
	});
	onMount(() => {
		void boot();
	});
	onDestroy(() => stopRealtime());
	onDestroy(() => {
		cancelOpenProgress();
		cancelJourney();
	});

	// Unload guard: staged (uncommitted) edits and unsaved table/navigation
	// drafts live only in this page's memory — losing the document loses them.
	// A `leave` navigation (reload / tab close) cancels into the browser's
	// native "leave site?" dialog; an in-app navigation asks via confirm().
	beforeNavigate((nav) => {
		if (!hasUnsavedWork()) return;
		if (nav.type === 'leave') {
			nav.cancel();
			return;
		}
		// The one browser dialog left in the app — every other confirmation now
		// goes through `confirm()` in `$lib/state/confirm.svelte`. It cannot be
		// used here: that helper returns a Promise, and `nav.cancel()` is a
		// no-op once this callback has returned, so an awaited answer would
		// arrive after the navigation it was meant to stop. The alternative —
		// cancel unconditionally, prompt, then re-`goto` — cannot faithfully
		// replay a cancelled popstate (a back-button nav would come back as a
		// forward push), so the synchronous dialog stays on purpose.
		if (
			!confirm('You have unsaved changes (tables, navigations, or edits). Leave and lose them?')
		) {
			nav.cancel();
		}
	});

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
		// Adopt the journey started on the picker/wizard click, or start one now for
		// a direct-URL landing. Idempotent: a create/open journey already running is
		// preserved (kind + slice table intact).
		beginJourney('open');
		try {
			void trackOpenProgress(); // fire-and-forget: feeds the journey while the requests below hydrate
			markViewUnresolved(); // reset the view-answered gate on every project (re)entry
			// …and drop the previous project's view state with it. The view stores
			// are module-scope singletons: an in-SPA project switch that left
			// project A's staged view ops in place would offer them for commit into
			// project B, naming folder ids B has never heard of. clearViewState()
			// nulls `_view` AND resets the journal; the boot sequence's own
			// refreshView() below repopulates it for this project.
			clearViewState();
			// Same leak, metamodel side (spec 2026-08-16): the staged-move store is
			// a module-scope singleton too, and `commitStaged` reads it
			// unconditionally. It is re-pointed only by `initMetamodelStage`, which
			// the metamodel TAB's init calls — so switching from project A to B
			// without ever opening B's metamodel tab would carry A's
			// `metamodel.move_node` ops into the next commit in B, naming diagram
			// nodes B has never heard of. `closeMetamodelStage()` and not
			// `discardStagedNodeMoves()`: it drops the in-memory copy while LEAVING
			// A's localStorage mirror intact, so switching back restores that work
			// instead of destroying it.
			closeMetamodelStage();
			// Same class of leak, issue side: the Validate overlay is a module-scope
			// singleton that WINS over the live issue map in every consumer, and boot
			// deliberately does not call resetModelStore(). Project A's origin-tagged
			// staged issues would render across project B's whole UI until B's
			// best-effort refetch below lands — forever, if it fails.
			clearOverlay();
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
				cancelOpenProgress(); // stop the status poll loop
				cancelJourney(); // and tear the progress bar down
				return;
			}
			await refreshView();
			try {
				await refreshSummary();
			} catch {
				return; // metamodel but no model
			}
			// Seed the live issue map immediately so a freshly opened project shows
			// its committed issues without waiting for a Validate click. Best-effort
			// like loadArtifacts below: a miss just means the sweep-completion or
			// next feed event heals it.
			void refetchIssues();
			try {
				await loadProjectInfo();
			} catch {
				// role/ttl best-effort; editing stays gated as viewer until it loads
			}
			await loadArtifacts().catch(() => {}); // artifact library is best-effort
		} finally {
			setProjectOpening(false);
			finishJourney(); // snap to 100% (honoring the min visible duration) and tear down; no-op if already cancelled
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

	// View-discard banner: a peer's change made a staged view edit unreplayable,
	// so `refreshView()` dropped the whole staged-view journal (Task 2). Unlike
	// the other banners above this one has no recovery action — the edits are
	// already gone — so it is purely informational, dismissed by the user
	// (the store keeps it live until the explicit Dismiss click; that survival
	// across the interim is the whole point).
	const viewDiscardNotice = $derived(getViewDiscardNotice());

	// Rebind is non-destructive: only the metamodel pointer and conformance issues change;
	// element ids and properties are untouched, so the cached element subset stays valid.
	// Unlike onReloadModel, we do NOT reset the model store — only the metamodel, issues, and rev.
	async function onReloadRebind(): Promise<void> {
		const mm = await fetchMetamodel();
		setMetamodel(mm);
		await refreshSummary();
		// The cheap read of the server's maintained issue store — NOT
		// runValidation(), which is POST /model/validate with no ops, i.e. the
		// full pipeline over a model that can be ~80 MB. (It would also install a
		// Validate overlay from a run the user never asked for, switching the
		// whole UI into overlay mode after someone else's rebind.) The local
		// rebind in MetamodelTab adopts the rebind response's issue list for the
		// same reason; this path has no such response, so it refetches.
		await refetchIssues();
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
			resetSnippetEditors();
			resetSnippetDocs();
			// resetCheckout() above dropped the lock registry, so every `folder:`
			// lease the staged view ops were relying on is gone from this client's
			// bookkeeping. Leaving the journal populated would send those ops at the
			// next commit with no folder tokens attached — a hard 409 "required lock
			// not held" with no obvious way to unwind. A reload is a full resync;
			// the view journal resyncs with everything else.
			resetViewEdits();
			// The staged metamodel MOVES go for exactly the same reason: the `mm`
			// token left the registry with the `folder:` ones above, so moves that
			// survived a reload would be sent at the next commit with no `mm`
			// token attached — the identical 409. `closeMetamodelStage()` rather
			// than `discardStagedNodeMoves()`, matching boot(): the persisted
			// mirror stays on disk, so re-opening the metamodel tab after the
			// resync restores the positions instead of losing them.
			closeMetamodelStage();
			clearSelection();
			// Deliberately NOT resetInspectionHistory(): a reload is the same project,
			// same ids, so the visit trail is still valid — unlike opening a different
			// project (reset at mount, above). resolveRows() prefers the live cache, so
			// the only residue is a stale name/type_name stamp on an entry until it is
			// re-visited or re-resolved.

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
			// resetModelStore() above emptied the live issue map while
			// refreshSummary() just restored the exact issue COUNTS — without this
			// the StatusBar reads "12 errors" over an IssuesPanel showing a green
			// "No issues.", the exact disagreement F-4/U-8 close, and nothing in
			// this path restarts the feed to heal it. Same best-effort call boot()
			// makes, same placement.
			void refetchIssues();
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
		const viewDiscardBanner = viewDiscardNotice !== null ? 'auto ' : '';
		return panelOpen
			? `auto ${errorBanner}${rebindBanner}${feedBanner}${viewDiscardBanner}1fr auto ${panelHeight}px auto`
			: `auto ${errorBanner}${rebindBanner}${feedBanner}${viewDiscardBanner}1fr auto`;
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
			in:slide={{ duration: dur(PANEL) }}
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
			in:slide={{ duration: dur(PANEL) }}
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
			in:slide={{ duration: dur(PANEL) }}
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
	{#if viewDiscardNotice !== null}
		<div
			class="col-span-5 flex items-center gap-3 bg-warning/15 px-3 py-1.5 text-xs text-warning"
			role="alert"
			in:slide={{ duration: dur(PANEL) }}
		>
			<span class="truncate">{viewDiscardNotice}</span>
			<Button
				size="sm"
				variant="ghost"
				class="ml-auto h-6 text-xs"
				onclick={() => clearViewDiscardNotice()}
			>
				Dismiss
			</Button>
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
