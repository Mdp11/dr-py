<script lang="ts">
	import { untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { FileCode, Route, Table, TriangleAlert } from '@lucide/svelte';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import {
		getCommittedArtifactHeaders,
		getExportArtifactsOpen,
		getExportArtifactsSeed,
		getStagedArtifactDepth,
		setExportArtifactsOpen
	} from '$lib/state';
	import {
		BUNDLE_FILENAME,
		exportBundle,
		exportPreview,
		type ExportPreview
	} from '$lib/api/artifact-bundle';
	import { saveResponseToFile } from '$lib/util/fileSave';

	type ArtifactKind = 'navigation' | 'table' | 'code_snippet';

	const SECTIONS: { kind: ArtifactKind; title: string; icon: typeof Route }[] = [
		{ kind: 'navigation', title: 'Navigations', icon: Route },
		{ kind: 'table', title: 'Tables', icon: Table },
		{ kind: 'code_snippet', title: 'Snippets', icon: FileCode }
	];

	// A local mirror of the store's open flag, bound two-way to Dialog.Root —
	// every other dialog in this codebase follows this bind:open shape (see
	// TableView's settings dialog and ExportDialog), which is what lets
	// bits-ui's OWN close (Escape, overlay click) round-trip through
	// onOpenChange while an external assignment (our effect below, or Cancel)
	// does not re-trigger it — see the comment on that effect.
	let open = $state(false);
	// GET /artifacts (behind getCommittedArtifactHeaders) returns every kind,
	// including legacy/unregistered ones like `diagram`/`diagram_kind` this
	// dialog has no section for. Filter down to the three kinds SECTIONS
	// covers ONCE, here, and derive everything else (visible, allVisibleChecked,
	// toggleAll, …) from the filtered list — otherwise a stray unrenderable row
	// can never be checked, which makes "Select all" permanently unreachable
	// and would silently promote that row to an export ROOT via toggleAll.
	const SECTION_KINDS: ReadonlySet<string> = new Set(SECTIONS.map((s) => s.kind));
	const headers = $derived(getCommittedArtifactHeaders().filter((h) => SECTION_KINDS.has(h.kind)));
	const hasStaged = $derived(getStagedArtifactDepth() > 0);

	const checked = new SvelteSet<string>();
	let filter = $state('');
	let preview = $state<ExportPreview | null>(null);
	let previewError = $state<string | null>(null);
	let exportError = $state<string | null>(null);
	let saving = $state(false);

	const DEBOUNCE_MS = 300;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let gen = 0;

	// Ids in the preview closure (checked roots + pulled-in dependencies).
	const closureIds = $derived(new Set((preview?.artifacts ?? []).map((a) => a.id)));

	// The EFFECTIVE selection: `checked` intersected with the live filtered
	// headers. `checked` is only ever ADDED to by user or seed action, but the
	// headers can shrink underneath it — a peer's delete commit over the
	// realtime feed removes the row while the untracked open-effect
	// (correctly) never reruns. Every consumer (hidden count, preview,
	// export, the submit gate) reads THIS, so a dead id can neither linger as
	// a phantom "+N selected not shown" nor be POSTed as an export root.
	const selected = $derived([...checked].filter((id) => headers.some((h) => h.id === id)));

	const visible = $derived.by(() => {
		const q = filter.trim().toLowerCase();
		return headers.filter((h) => q === '' || h.name.toLowerCase().includes(q));
	});
	const hiddenSelected = $derived(
		selected.filter((id) => !visible.some((h) => h.id === id)).length
	);
	const allVisibleChecked = $derived(visible.length > 0 && visible.every((h) => checked.has(h.id)));

	// Open/close lifecycle: seed the selection and fire the first preview
	// immediately on an open TRANSITION. Reads the STORE (not the local
	// `open`) and writes the local `open` — never the reverse — so this can
	// never be the write side of a read/write loop with itself. The close
	// branch only cancels the pending debounce and bumps the generation
	// counter; the rest of the local state (`checked`, `filter`, `preview`,
	// …) is left as-is and gets reset on the NEXT open, not here.
	//
	// This effect must depend ONLY on `getExportArtifactsOpen()` and
	// `getExportArtifactsSeed()` — both read directly below, un-wrapped — so
	// it reruns only on an actual open/seed change. `getCommittedArtifactHeaders()`
	// is read through `untrack()` on purpose: it is genuinely reactive
	// (`artifacts.svelte.ts`'s `_items` $state) and changes on ANY committed
	// artifact create/rename/delete, including a peer's commit arriving over
	// the realtime feed while this dialog is open. Without `untrack()`, that
	// unrelated change would rerun this whole effect and wipe every checkbox
	// the user had toggled since opening, re-seeding from the ORIGINAL seed
	// array as if the dialog had just reopened.
	$effect(() => {
		const isOpen = getExportArtifactsOpen();
		const seed = getExportArtifactsSeed();
		open = isOpen;
		if (isOpen) {
			// The FILTERED `headers`, not the raw store: a seed id whose kind has
			// no section (legacy `diagram`) must be dropped here, or it enters
			// `checked` without ever rendering a row — an invisible selection
			// that would silently become an export root. `headers` is a $derived
			// over the same reactive store, so it too goes through `untrack()`.
			const ids = new Set(untrack(() => headers).map((h) => h.id));
			checked.clear();
			let anySeeded = false;
			for (const id of seed) {
				if (ids.has(id)) {
					checked.add(id);
					anySeeded = true;
				}
			}
			filter = '';
			preview = null;
			previewError = null;
			exportError = null;
			// Schedule rather than call runPreview() synchronously: runPreview
			// reads `checked` (a piece of state this effect just wrote), and
			// reading state an effect also writes within the same synchronous
			// run trips Svelte's effect_update_depth_exceeded guard. Routing
			// through the same setTimeout plumbing as the debounced path (with
			// delay 0 for "immediate") keeps the read outside any active effect.
			if (anySeeded) schedulePreview(0);
		} else {
			if (timer !== null) clearTimeout(timer);
			timer = null;
			gen++;
		}
	});

	// A bare mount/unmount effect: it reads nothing reactive, so it runs once
	// and its cleanup fires only on component destroy. That is what makes this
	// dialog safe to mount TRANSIENTLY (e.g. a test, or an unmount mid-debounce)
	// without leaking a pending `setTimeout` past the component's lifetime —
	// the close-branch cleanup above only guards the open/close transition, not
	// an unmount that skips it entirely.
	$effect(() => {
		return () => {
			if (timer !== null) clearTimeout(timer);
		};
	});

	async function runPreview(): Promise<void> {
		const g = ++gen;
		if (selected.length === 0) {
			preview = null;
			previewError = null;
			return;
		}
		try {
			const res = await exportPreview(selected);
			if (g !== gen) return; // stale response
			preview = res;
			previewError = null;
		} catch {
			if (g !== gen) return;
			previewError = 'Could not compute the bundle preview.';
		}
	}

	function schedulePreview(delay: number = DEBOUNCE_MS): void {
		if (timer !== null) clearTimeout(timer);
		timer = setTimeout(() => void runPreview(), delay);
	}

	function toggle(id: string): void {
		if (checked.has(id)) checked.delete(id);
		else checked.add(id);
		schedulePreview();
	}

	function toggleSection(kind: ArtifactKind): void {
		const rows = visible.filter((h) => h.kind === kind);
		const allChecked = rows.length > 0 && rows.every((h) => checked.has(h.id));
		for (const h of rows) {
			if (allChecked) checked.delete(h.id);
			else checked.add(h.id);
		}
		schedulePreview();
	}

	function toggleAll(): void {
		// Snapshot BEFORE the loop: `allVisibleChecked` is a $derived over
		// `checked`, so reading it fresh on each iteration would see it flip
		// false the moment the first delete below makes it no longer true,
		// turning every subsequent iteration's delete into a re-add instead.
		const wasAllChecked = allVisibleChecked;
		for (const h of visible) {
			if (wasAllChecked) checked.delete(h.id);
			else checked.add(h.id);
		}
		schedulePreview();
	}

	async function onExport(): Promise<void> {
		exportError = null;
		saving = true;
		try {
			const resp = await exportBundle(selected);
			await saveResponseToFile(resp, BUNDLE_FILENAME);
			setExportArtifactsOpen(false);
		} catch (err) {
			if (err instanceof DOMException && err.name === 'AbortError') return; // user cancelled save
			exportError = 'Export failed. Try again.';
		} finally {
			saving = false;
		}
	}
</script>

<Dialog.Root bind:open onOpenChange={(v) => setExportArtifactsOpen(v)}>
	<Dialog.Content class="max-w-lg">
		<Dialog.Header>
			<Dialog.Title class="font-display text-lg font-light tracking-wide">
				Export artifacts
			</Dialog.Title>
			<Dialog.Description>
				Selected artifacts and everything they reference are bundled into one file.
			</Dialog.Description>
		</Dialog.Header>

		<div class="flex flex-col gap-3">
			{#if hasStaged}
				<p class="text-xs text-muted-foreground">Uncommitted artifact changes are not exported.</p>
			{/if}

			<div class="flex items-center gap-2">
				<Input
					data-testid="export-filter"
					bind:value={filter}
					placeholder="Filter artifacts…"
					autofocus
					class="flex-1"
				/>
				<label class="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
					<input
						type="checkbox"
						data-testid="export-select-all"
						checked={allVisibleChecked}
						onchange={toggleAll}
					/>
					Select all
				</label>
			</div>

			<div class="flex max-h-72 flex-col gap-2 overflow-y-auto">
				{#each SECTIONS as section (section.kind)}
					{@const rows = visible.filter((h) => h.kind === section.kind)}
					{#if rows.length > 0}
						{@const sectionAllChecked = rows.every((h) => checked.has(h.id))}
						<section class="flex flex-col gap-0.5">
							<label class="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
								<input
									type="checkbox"
									data-testid={`export-section-all-${section.kind}`}
									checked={sectionAllChecked}
									onchange={() => toggleSection(section.kind)}
								/>
								{section.title}
							</label>
							{#each rows as h (h.id)}
								<label
									data-testid={`export-row-${h.id}`}
									class="flex items-center gap-2 rounded px-1.5 py-0.5 text-xs text-foreground/80 hover:bg-muted"
								>
									<input
										type="checkbox"
										checked={checked.has(h.id)}
										onchange={() => toggle(h.id)}
									/>
									<section.icon class="size-3.5 shrink-0 text-info" />
									<span class="flex-1 truncate">{h.name}</span>
									{#if !checked.has(h.id) && closureIds.has(h.id)}
										<span class="rounded bg-muted px-1 text-[10px] text-muted-foreground">
											dependency
										</span>
									{/if}
								</label>
							{/each}
						</section>
					{/if}
				{/each}
			</div>

			{#if hiddenSelected > 0}
				<p class="text-xs text-muted-foreground">+{hiddenSelected} selected not shown</p>
			{/if}

			<div class="flex flex-col gap-1 border-t border-border pt-2 text-xs">
				<p class="text-muted-foreground">
					{preview?.artifacts.length ?? selected.length} artifacts
				</p>
				{#if preview && preview.dangling_refs.length > 0}
					<p class="flex items-center gap-1 text-warning" data-testid="export-dangling-refs">
						<TriangleAlert class="size-3.5" />
						{preview.dangling_refs.length} dangling reference{preview.dangling_refs.length === 1
							? ''
							: 's'} — these ids are referenced but not part of this project; they export as-is
					</p>
				{/if}
				{#if previewError}
					<p role="alert" class="text-destructive">{previewError}</p>
				{/if}
				{#if exportError}
					<p role="alert" class="text-destructive">{exportError}</p>
				{/if}
			</div>
		</div>

		<Dialog.Footer>
			<Button type="button" variant="ghost" onclick={() => setExportArtifactsOpen(false)}>
				Cancel
			</Button>
			<Button
				type="button"
				data-testid="export-submit"
				disabled={selected.length === 0 || saving}
				onclick={() => void onExport()}
			>
				{saving ? 'Exporting…' : 'Export bundle'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
