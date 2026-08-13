<script lang="ts">
	import { Route } from '@lucide/svelte';
	import { KIND_ICONS, type ArtifactKind } from '$lib/artifacts/kinds';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { getImportArtifactsOpen, loadArtifacts, setImportArtifactsOpen } from '$lib/state';
	import { ConflictError } from '$lib/api/errors';
	import {
		importConfirm,
		importPlan,
		parseBundleText,
		StalePlanImportError,
		type ArtifactBundle,
		type ImportConfirmResponse,
		type ImportPlan,
		type PlanEntry
	} from '$lib/api/artifact-bundle';

	type Action = 'create' | 'reuse' | 'copy';
	type Phase = 'pick' | 'review' | 'result';

	const ACTION_LABEL: Record<Action, string> = {
		create: 'Create',
		reuse: 'Reuse existing',
		copy: 'Copy under new name'
	};

	// A local mirror of the store's open flag, bound two-way to Dialog.Root —
	// see ExportArtifactsDialog's comment: a plain $derived passed as a
	// non-bound prop never renders bits-ui's portalled content in tests, and
	// this is what lets bits-ui's OWN close (Escape, overlay click) round-trip
	// through onOpenChange while an external assignment (Cancel/Close, or the
	// effect below) does not re-trigger it.
	let open = $state(false);

	let phase = $state<Phase>('pick');
	let fileName = $state('');
	let bundle = $state<ArtifactBundle | null>(null);
	let plan = $state<ImportPlan | null>(null);
	let decisions = $state<Record<string, Action>>({});
	let copyNames = $state<Record<string, string>>({}); // USER edits only
	let message = $state('');
	let banner = $state<string | null>(null);
	let parseError = $state<string | null>(null);
	let busy = $state(false);
	let result = $state<ImportConfirmResponse | null>(null);
	let fileInputRef = $state<HTMLInputElement | null>(null);

	// Bumped on every open/close transition; `onFilePicked`/`onConfirm` each
	// capture it before their first await and refuse to write any state after
	// an await if it no longer matches — this is what protects a close (or a
	// close-then-reopen) that happens BEFORE an in-flight request settles, a
	// hole `reset()` alone cannot close: `reset()` only clears what already
	// exists, it cannot stop a stale continuation from writing OVER a fresh
	// reopened state a moment later.
	let gen = 0;

	// Sync the local mirror from the store on every store change, and reset ALL
	// local state on BOTH the open and close transitions (including bits-ui's
	// own Escape/overlay close, which writes the store via onOpenChange below
	// and so still lands here) — a reopen must be unconditionally fresh, not
	// just a close. This effect depends ONLY on getImportArtifactsOpen() —
	// nothing else is read reactively — so it never reruns for reasons
	// unrelated to open/close.
	$effect(() => {
		const isOpen = getImportArtifactsOpen();
		open = isOpen;
		gen++;
		reset();
	});

	function reset(): void {
		phase = 'pick';
		fileName = '';
		bundle = null;
		plan = null;
		decisions = {};
		copyNames = {};
		message = '';
		banner = null;
		parseError = null;
		busy = false;
		result = null;
	}

	/** The actions build_import_ops can honor for this entry — mirror of the
	 * backend matrix; offering anything wider guarantees a StalePlanError. */
	function legalActions(e: PlanEntry): Action[] {
		if (e.action === 'create') return ['create', 'copy'];
		if (e.action === 'reuse') return ['reuse', 'copy'];
		return ['copy', 'reuse'];
	}

	function effectiveAction(e: PlanEntry): Action {
		return decisions[e.bundle_id] ?? e.action;
	}

	/** Adopt a fresh plan, keeping prior decisions/renames only where the
	 * fresh entry still allows them. */
	function adoptPlan(fresh: ImportPlan): void {
		const d: Record<string, Action> = {};
		const c: Record<string, string> = {};
		for (const e of fresh.entries) {
			const prev = decisions[e.bundle_id];
			d[e.bundle_id] = prev !== undefined && legalActions(e).includes(prev) ? prev : e.action;
			const name = copyNames[e.bundle_id];
			if (name !== undefined && d[e.bundle_id] === 'copy') c[e.bundle_id] = name;
		}
		plan = fresh;
		decisions = d;
		copyNames = c;
	}

	async function onFilePicked(f: File | null | undefined): Promise<void> {
		if (!f) return;
		const g = gen;
		parseError = null;
		banner = null; // a stale banner from a previous (now-abandoned) import must not survive onto this pick
		let parsed: ArtifactBundle;
		try {
			parsed = parseBundleText(await f.text());
		} catch {
			if (g !== gen) return; // dialog was closed (and maybe reopened) while text()/parse was in flight
			parseError = 'Not a valid artifact bundle file.';
			return;
		}
		if (g !== gen) return;
		fileName = f.name;
		bundle = parsed;
		busy = true;
		try {
			const p = await importPlan(parsed);
			if (g !== gen) return; // dialog was closed (and maybe reopened) while the plan request was in flight
			decisions = {};
			copyNames = {};
			adoptPlan(p);
			phase = 'review';
		} catch (err) {
			if (g !== gen) return;
			parseError = err instanceof Error ? err.message : 'Could not plan the import.';
		} finally {
			if (g === gen) busy = false;
		}
	}

	function onDrop(e: DragEvent): void {
		e.preventDefault();
		void onFilePicked(e.dataTransfer?.files?.[0]);
	}

	const toCreate = $derived(
		(plan?.entries ?? []).filter((e) => effectiveAction(e) !== 'reuse').length
	);
	const toReuse = $derived(
		(plan?.entries ?? []).filter((e) => effectiveAction(e) === 'reuse').length
	);

	async function onConfirm(): Promise<void> {
		if (bundle === null || plan === null) return;
		const g = gen;
		banner = null;
		busy = true;
		try {
			const d: Record<string, Action> = {};
			for (const e of plan.entries) d[e.bundle_id] = effectiveAction(e);
			const res = await importConfirm({
				bundle,
				decisions: d,
				copyNames,
				message: message.trim()
			});
			if (g !== gen) return; // dialog was closed (and maybe reopened) while the confirm request was in flight
			result = res;
			phase = 'result';
			void loadArtifacts().catch(() => {});
		} catch (err) {
			if (g !== gen) return;
			if (err instanceof StalePlanImportError) {
				adoptPlan(err.plan);
				banner = err.detail;
			} else if (err instanceof ConflictError && bundle !== null) {
				try {
					const fresh = await importPlan(bundle);
					if (g !== gen) return;
					adoptPlan(fresh);
					banner = 'The project changed concurrently — the plan was refreshed.';
				} catch {
					if (g !== gen) return;
					banner = 'The project changed concurrently. Close and retry.';
				}
			} else {
				banner = err instanceof Error ? err.message : 'Import failed.';
			}
		} finally {
			if (g === gen) busy = false;
		}
	}
</script>

<Dialog.Root bind:open onOpenChange={(v) => setImportArtifactsOpen(v)}>
	<Dialog.Content class="max-w-lg">
		<Dialog.Header>
			<Dialog.Title class="font-display text-lg font-light tracking-wide">
				Import artifacts
			</Dialog.Title>
			<Dialog.Description>
				Pick a bundle file exported from another project. Review the plan before importing.
			</Dialog.Description>
		</Dialog.Header>

		{#if phase === 'pick'}
			<div class="flex flex-col gap-3">
				<button
					type="button"
					class="flex flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border px-4 py-8 text-xs text-muted-foreground transition-colors hover:bg-muted"
					ondrop={onDrop}
					ondragover={(e) => e.preventDefault()}
					onclick={() => fileInputRef?.click()}
				>
					Drop a bundle file here, or click to choose one.
				</button>
				<input
					bind:this={fileInputRef}
					type="file"
					accept=".json"
					data-testid="import-file"
					class="hidden"
					onchange={(e) => {
						const input = e.currentTarget as HTMLInputElement;
						void onFilePicked(input.files?.[0]);
						// Clear the input's value so re-picking the SAME filename after a
						// parse/plan error still fires a `change` event — the browser
						// treats an unchanged `value` as a no-op and never re-dispatches.
						input.value = '';
					}}
				/>
				{#if parseError}
					<p data-testid="import-parse-error" role="alert" class="text-xs text-destructive">
						{parseError}
					</p>
				{/if}
			</div>

			<Dialog.Footer>
				<Button type="button" variant="ghost" onclick={() => setImportArtifactsOpen(false)}>
					Cancel
				</Button>
			</Dialog.Footer>
		{:else if phase === 'review'}
			<div class="flex flex-col gap-3">
				<div class="text-xs text-muted-foreground">
					<p class="truncate font-mono">{fileName}</p>
					<p>from {bundle?.source_project.name} · exported {bundle?.exported_at}</p>
				</div>

				{#if banner}
					<p data-testid="import-banner" role="alert" class="text-xs text-warning">{banner}</p>
				{/if}

				<div class="flex max-h-72 flex-col gap-2 overflow-y-auto">
					{#each plan?.entries ?? [] as e (e.bundle_id)}
						{@const Icon = KIND_ICONS[e.kind as ArtifactKind] ?? Route}
						{@const action = effectiveAction(e)}
						<div
							data-testid={`import-row-${e.bundle_id}`}
							class="flex flex-col gap-1 rounded border border-border px-2 py-1.5 text-xs"
						>
							<div class="flex items-center gap-2">
								<Icon class="size-3.5 shrink-0 text-info" />
								<span class="flex-1 truncate">{e.name}</span>
								<select
									data-testid={`import-action-${e.bundle_id}`}
									value={action}
									onchange={(ev) => {
										const v = (ev.currentTarget as HTMLSelectElement).value as Action;
										decisions = { ...decisions, [e.bundle_id]: v };
									}}
									class="rounded border border-input bg-card px-1 py-0.5 text-xs"
								>
									{#each legalActions(e) as a (a)}
										<option value={a}>{ACTION_LABEL[a]}</option>
									{/each}
								</select>
							</div>
							{#if action === 'reuse'}
								<p class="text-muted-foreground">identical already exists</p>
							{:else if action === 'copy'}
								{#if e.action === 'copy'}
									<!-- Gated on the PLAN's own action, not the effective one: a
									     `create`/`reuse` row flipped to Copy by the user has no
									     existing row to differ from, so this hint would be false. -->
									<p class="text-muted-foreground">differs from existing</p>
								{/if}
								<input
									type="text"
									data-testid={`import-name-${e.bundle_id}`}
									value={copyNames[e.bundle_id] ?? e.copy_name ?? e.name}
									oninput={(ev) => {
										copyNames = {
											...copyNames,
											[e.bundle_id]: (ev.currentTarget as HTMLInputElement).value
										};
									}}
									class="rounded border border-input bg-card px-1.5 py-0.5 text-xs"
								/>
							{/if}
						</div>
					{/each}
				</div>

				{#if plan && plan.skipped.length > 0}
					<div
						data-testid="import-skipped"
						class="flex flex-col gap-0.5 text-xs text-muted-foreground"
					>
						{#each plan.skipped as s (s.bundle_id)}
							<p>{s.bundle_id} — {s.reason}</p>
						{/each}
					</div>
				{/if}
			</div>

			<Dialog.Footer class="flex-col items-stretch gap-2">
				<Input
					data-testid="import-message"
					bind:value={message}
					placeholder={`Imported ${toCreate} artifacts from ${bundle?.source_project.name ?? ''}`}
				/>
				<div class="flex items-center justify-between gap-2">
					<p class="text-xs text-muted-foreground">
						{toCreate} to create, {toReuse} to reuse, {plan?.skipped.length ?? 0} skipped
					</p>
					<div class="flex gap-2">
						<Button type="button" variant="ghost" onclick={() => setImportArtifactsOpen(false)}>
							Cancel
						</Button>
						<Button
							type="button"
							data-testid="import-submit"
							disabled={busy}
							onclick={() => void onConfirm()}
						>
							Import ({toCreate})
						</Button>
					</div>
				</div>
			</Dialog.Footer>
		{:else}
			<div data-testid="import-result" class="flex flex-col gap-2 text-xs">
				{#if result?.rev === null}
					<p>Nothing to import — everything already exists.</p>
				{:else}
					{#if result && result.created.length > 0}
						<div>
							<p class="font-medium">Created</p>
							<ul>
								{#each result.created as c (c.id)}
									<li>{c.name}</li>
								{/each}
							</ul>
						</div>
					{/if}
					<p>{result?.reused.length ?? 0} reused</p>
				{/if}
				{#if result && result.skipped.length > 0}
					<div>
						<p class="font-medium">Skipped</p>
						{#each result.skipped as s (s.bundle_id)}
							<p>{s.bundle_id} — {s.reason}</p>
						{/each}
					</div>
				{/if}
			</div>

			<Dialog.Footer>
				<Button type="button" onclick={() => setImportArtifactsOpen(false)}>Close</Button>
			</Dialog.Footer>
		{/if}
	</Dialog.Content>
</Dialog.Root>
