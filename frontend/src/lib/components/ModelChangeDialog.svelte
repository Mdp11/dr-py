<script lang="ts">
	import {
		compareModel,
		proposeCr,
		MAX_CRS_PER_REQUEST,
		type CompareOut
	} from '$lib/api/changeRequest';
	import {
		canEdit,
		getFilename,
		getModelRev,
		getModelSummary,
		hasStagedOps,
		setLockNotice
	} from '$lib/state';
	import { stageProposedOps } from '$lib/state/stage-proposed';
	import {
		composeCrFilename,
		crPrestate,
		crToDiff,
		invertChangeRequest,
		type ChangeRequest,
		type CrConflictReport,
		type CrPreview
	} from '$lib/state/cr';
	import { saveJsonToFile } from '$lib/util/fileSave';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import ProposalPreview from './ProposalPreview.svelte';

	// One dialog, two sources. Everything below the source strip is shared:
	// a proposal is previewed and staged the same way whether it came from a
	// model file (compare) or from CR files (apply-cr). Nothing runs on file
	// selection — every request sits behind an explicit button.
	type Mode = 'compare' | 'apply-cr';
	let { open = $bindable(false), mode }: { open: boolean; mode: Mode } = $props();

	// compare-mode source
	let otherFile = $state<File | null>(null);
	let swapped = $state(false);
	// cached per rev: Preview then Replace must not upload the file twice
	let compared = $state<{ rev: number; out: CompareOut } | null>(null);
	// apply-cr-mode source (display order = apply order). `uid` is assigned once
	// per entry so the keyed list moves rows on reorder instead of re-creating
	// them (two files may share a name).
	let crFiles = $state<{ uid: string; name: string; cr: ChangeRequest }[]>([]);
	let uidCounter = 0;
	// shared output
	let preview = $state<CrPreview | null>(null);
	let conflicts = $state<CrConflictReport | null>(null);
	let error = $state<string | null>(null);
	let busy = $state(false);
	let fileInputRef = $state<HTMLInputElement | null>(null);

	const editable = $derived(canEdit());
	const bufferDirty = $derived(hasStagedOps());
	const hasSource = $derived(mode === 'compare' ? otherFile !== null : crFiles.length > 0);
	// the server refuses a longer batch at request-parse time; saying so here
	// beats surfacing the raw pydantic message
	const tooManyCrs = $derived(mode === 'apply-cr' && crFiles.length > MAX_CRS_PER_REQUEST);
	// Replace/Stage compute against the COMMITTED model: pre-existing staged
	// edits would surface as conflicts or double edits, so a clean buffer is
	// required. Replace is session -> file by definition, hence off when swapped.
	const proceedDisabled = $derived(
		busy || !hasSource || !editable || bufferDirty || tooManyCrs || (mode === 'compare' && swapped)
	);
	// compare-mode Preview is POST /model/compare (viewer-allowed); apply-cr's
	// is POST /model/apply-cr, which stays a write, so a viewer would only 403
	const previewDisabled = $derived(
		busy || !hasSource || tooManyCrs || (mode === 'apply-cr' && !editable)
	);
	const sessionLabel = $derived(getFilename() ?? 'model');
	const otherLabel = $derived(otherFile?.name ?? 'other');

	const STAGE_FAILURES = {
		empty: 'Nothing to stage — the models are identical.',
		stale: 'The model changed since the proposal — preview again.',
		locks: 'Could not acquire the locks needed to stage these edits.',
		missing: 'An entity the proposal touches no longer exists — preview again.'
	} as const;

	function clearOutput(): void {
		preview = null;
		conflicts = null;
		error = null;
	}

	function reset(): void {
		otherFile = null;
		swapped = false;
		compared = null;
		crFiles = [];
		busy = false;
		clearOutput();
	}

	function onOpenChange(next: boolean): void {
		open = next;
		if (!next) reset();
	}

	async function onFilesSelected(event: Event): Promise<void> {
		const target = event.target as HTMLInputElement;
		const files = [...(target.files ?? [])];
		target.value = '';
		if (files.length === 0) return;
		clearOutput();
		if (mode === 'compare') {
			otherFile = files[0];
			compared = null;
			return;
		}
		// every rejected file is reported, not just the last one
		const rejected: string[] = [];
		for (const file of files) {
			try {
				const parsed = JSON.parse(await file.text());
				if (parsed?.format !== 'datarover.cr/v1') {
					rejected.push(`${file.name}: not a CR file (expected format datarover.cr/v1)`);
					continue;
				}
				crFiles = [
					...crFiles,
					{ uid: `cr-${++uidCounter}`, name: file.name, cr: parsed as ChangeRequest }
				];
			} catch (err) {
				rejected.push(`${file.name}: ${err instanceof Error ? err.message : 'Invalid JSON'}`);
			}
		}
		if (rejected.length > 0) error = `Skipped ${rejected.length} file(s) — ${rejected.join('; ')}`;
	}

	function moveCr(i: number, delta: number): void {
		const j = i + delta;
		if (j < 0 || j >= crFiles.length) return;
		const next = [...crFiles];
		[next[i], next[j]] = [next[j], next[i]];
		crFiles = next;
		clearOutput();
	}

	function removeCr(i: number): void {
		crFiles = crFiles.filter((_, k) => k !== i);
		clearOutput();
	}

	async function ensureCompared(): Promise<CompareOut> {
		const rev = getModelRev();
		if (compared && compared.rev === rev) return compared.out;
		if (!otherFile) throw new Error('Choose a model file first');
		const out = await compareModel(otherFile);
		compared = { rev, out };
		return out;
	}

	function directedCr(out: CompareOut): ChangeRequest {
		return swapped ? invertChangeRequest(out.cr) : out.cr;
	}

	function previewOf(cr: ChangeRequest, toTotal: number): CrPreview {
		const diff = crToDiff(cr);
		return {
			diff,
			unchangedHidden: Math.max(0, toTotal - diff.counts.added - diff.counts.modified)
		};
	}

	function sessionTotal(): number {
		const s = getModelSummary();
		return s ? s.element_count + s.relationship_count : 0;
	}

	async function run(fn: () => Promise<void>): Promise<void> {
		busy = true;
		clearOutput();
		try {
			await fn();
		} catch (err) {
			if (err instanceof DOMException && err.name === 'AbortError') return;
			error = err instanceof Error ? err.message : String(err);
		} finally {
			busy = false;
		}
	}

	function onPreview(): Promise<void> {
		return run(async () => {
			if (mode === 'compare') {
				const out = await ensureCompared();
				const toTotal = swapped
					? sessionTotal()
					: out.other_element_count + out.other_relationship_count;
				preview = previewOf(directedCr(out), toTotal);
				return;
			}
			const res = await proposeCr(crFiles.map((f) => f.cr));
			if (!res.ok) {
				conflicts = { crIndex: res.crIndex, items: res.conflicts };
				return;
			}
			const { baseline, ops } = res.cr;
			const toTotal =
				baseline.elementCount +
				baseline.relationshipCount +
				ops.elements.added.length +
				ops.relationships.added.length -
				ops.elements.deleted.length -
				ops.relationships.deleted.length;
			preview = previewOf(res.cr, toTotal);
		});
	}

	function onCreateCr(): Promise<void> {
		return run(async () => {
			const out = await ensureCompared();
			const cr = directedCr(out);
			// strip the transport-only `complete` flag so the file is exactly the
			// datarover.cr/v1 shape Apply CR expects (same as saveWithOptionalCr),
			// and relabel the baseline: inverting a CR keeps the envelope as-is,
			// so the baseline must be restated for the direction actually saved
			// (the filename too — the server never knows it).
			const doc: Record<string, unknown> = {
				...cr,
				baseline: swapped
					? {
							filename: otherLabel,
							elementCount: out.other_element_count,
							relationshipCount: out.other_relationship_count
						}
					: { ...cr.baseline, filename: getFilename() }
			};
			delete doc.complete;
			await saveJsonToFile(doc, composeCrFilename(swapped ? otherLabel : getFilename()));
		});
	}

	function onProceed(): Promise<void> {
		return run(async () => {
			const crs = mode === 'compare' ? [(await ensureCompared()).cr] : crFiles.map((f) => f.cr);
			const res = await proposeCr(crs);
			if (!res.ok) {
				conflicts = { crIndex: mode === 'compare' ? null : res.crIndex, items: res.conflicts };
				return;
			}
			const outcome = await stageProposedOps(res.ops, res.modelRev, crPrestate(res.cr));
			if (!outcome.ok) {
				error = STAGE_FAILURES[outcome.reason];
				return;
			}
			setLockNotice(`${outcome.count} edits staged — review with Ctrl+S`);
			onOpenChange(false);
		});
	}

	const rowBtn =
		'rounded px-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40';
</script>

<Dialog.Root bind:open {onOpenChange}>
	<Dialog.Content class="max-w-4xl">
		<Dialog.Header>
			<Dialog.Title class="font-display text-lg font-light tracking-wide">
				{mode === 'compare' ? 'Compare models' : 'Apply change requests'}
			</Dialog.Title>
			<Dialog.Description>
				{#if mode === 'compare'}
					Diff the loaded model against another model file. Replace stages every edit that makes the
					loaded model match the file; Create CR saves the diff as a change request.
				{:else}
					Pick one or more CR files. They are applied in order against the loaded model and the
					result is staged for review — never committed directly.
				{/if}
			</Dialog.Description>
		</Dialog.Header>

		<div class="flex flex-col gap-3">
			<div class="flex flex-wrap items-center gap-2 text-sm">
				<Button type="button" variant="outline" size="sm" onclick={() => fileInputRef?.click()}>
					{mode === 'compare' ? 'Choose model…' : 'Add CR files…'}
				</Button>
				<input
					bind:this={fileInputRef}
					type="file"
					accept=".json"
					multiple={mode === 'apply-cr'}
					class="hidden"
					data-testid="mcd-file-input"
					onchange={onFilesSelected}
				/>
				{#if mode === 'compare'}
					<span class="font-mono text-xs text-muted-foreground" aria-live="polite">
						{otherFile?.name ?? 'No file selected'}
					</span>
					{#if otherFile}
						<span class="ml-2 text-xs text-muted-foreground">
							From <span class="font-mono text-foreground/80"
								>{swapped ? otherLabel : sessionLabel}</span
							>
							→ To
							<span class="font-mono text-foreground/80">{swapped ? sessionLabel : otherLabel}</span
							>
						</span>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							class="h-7 text-xs"
							data-testid="mcd-swap"
							onclick={() => {
								swapped = !swapped;
								clearOutput();
							}}
						>
							⇄ Swap
						</Button>
					{/if}
				{/if}
			</div>

			{#if mode === 'apply-cr'}
				{#if crFiles.length === 0}
					<p class="text-xs text-muted-foreground">No CR files added.</p>
				{:else}
					<ol class="flex flex-col gap-1">
						{#each crFiles as f, i (f.uid)}
							<li
								class="flex items-center gap-2 rounded border border-border px-2 py-1 text-xs"
								data-testid={`mcd-cr-row-${i}`}
							>
								<span class="w-6 text-muted-foreground">#{i + 1}</span>
								<span class="flex-1 truncate font-mono">{f.name}</span>
								<button
									type="button"
									class={rowBtn}
									data-testid={`mcd-cr-up-${i}`}
									aria-label="Move up"
									disabled={i === 0}
									onclick={() => moveCr(i, -1)}>↑</button
								>
								<button
									type="button"
									class={rowBtn}
									data-testid={`mcd-cr-down-${i}`}
									aria-label="Move down"
									disabled={i === crFiles.length - 1}
									onclick={() => moveCr(i, 1)}>↓</button
								>
								<button
									type="button"
									class={rowBtn}
									data-testid={`mcd-cr-remove-${i}`}
									aria-label="Remove"
									onclick={() => removeCr(i)}>✕</button
								>
							</li>
						{/each}
					</ol>
				{/if}
			{/if}

			{#if tooManyCrs}
				<p class="text-xs text-muted-foreground" data-testid="mcd-gate-hint">
					{crFiles.length} CR files added — at most {MAX_CRS_PER_REQUEST} can be applied in one request.
					Remove some and try again.
				</p>
			{:else if hasSource && !editable}
				<p class="text-xs text-muted-foreground" data-testid="mcd-gate-hint">
					{#if mode === 'compare'}
						You have view-only access — Replace is unavailable.
					{:else}
						You have view-only access — Stage edits is unavailable, and so is Preview diff (it asks
						the server to propose the edits, which viewers may not do).
					{/if}
				</p>
			{:else if hasSource && bufferDirty}
				<p class="text-xs text-muted-foreground" data-testid="mcd-gate-hint">
					Commit or discard your staged edits first.
				</p>
			{/if}

			<div class="max-h-[60vh] overflow-y-auto">
				<ProposalPreview {preview} {conflicts} {error} />
			</div>
		</div>

		<Dialog.Footer>
			<Button type="button" variant="ghost" onclick={() => onOpenChange(false)} disabled={busy}>
				Close
			</Button>
			<Button
				type="button"
				variant="outline"
				data-testid="mcd-preview"
				disabled={previewDisabled}
				onclick={() => void onPreview()}
			>
				Preview diff
			</Button>
			{#if mode === 'compare'}
				<Button
					type="button"
					variant="outline"
					data-testid="mcd-create-cr"
					disabled={busy || !hasSource}
					onclick={() => void onCreateCr()}
				>
					Create CR
				</Button>
				<Button
					type="button"
					data-testid="mcd-replace"
					disabled={proceedDisabled}
					title={swapped
						? 'Replace always goes from the loaded model to the file — swap back to enable it'
						: undefined}
					onclick={() => void onProceed()}
				>
					{busy ? 'Working…' : 'Replace'}
				</Button>
			{:else}
				<Button
					type="button"
					data-testid="mcd-stage"
					disabled={proceedDisabled}
					onclick={() => void onProceed()}
				>
					{busy ? 'Working…' : 'Stage edits'}
				</Button>
			{/if}
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
