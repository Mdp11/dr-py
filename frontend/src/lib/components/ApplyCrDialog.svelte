<script lang="ts">
	import { applyCr } from '$lib/api/changeRequest';
	import type { ApplyCrResult } from '$lib/api/changeRequest';
	import type { ChangeRequest } from '$lib/state/cr';
	import type { InlineModel } from '$lib/api/types';
	import { saveJsonToFile } from '$lib/util/fileSave';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';

	let { open = $bindable(false) }: { open: boolean } = $props();

	let model: InlineModel | null = $state(null);
	let modelFilename: string | null = $state(null);
	let cr: ChangeRequest | null = $state(null);
	let crFilename: string | null = $state(null);
	let result: ApplyCrResult | null = $state(null);
	let errorMessage: string | null = $state(null);
	let busy = $state(false);
	let modelInputRef: HTMLInputElement | null = $state(null);
	let crInputRef: HTMLInputElement | null = $state(null);

	function onOpenChange(next: boolean): void {
		open = next;
		if (!next) {
			model = null;
			modelFilename = null;
			cr = null;
			crFilename = null;
			result = null;
			errorMessage = null;
			busy = false;
		}
	}

	async function onModelSelected(event: Event): Promise<void> {
		const target = event.target as HTMLInputElement;
		const file = target.files?.[0];
		target.value = '';
		if (!file) return;
		try {
			const parsed = JSON.parse(await file.text());
			model = { elements: parsed.elements ?? [], relationships: parsed.relationships ?? [] };
			modelFilename = file.name;
			errorMessage = null;
			result = null;
		} catch (err) {
			model = null;
			errorMessage = err instanceof Error ? err.message : 'Invalid JSON';
		}
	}

	async function onCrSelected(event: Event): Promise<void> {
		const target = event.target as HTMLInputElement;
		const file = target.files?.[0];
		target.value = '';
		if (!file) return;
		try {
			const parsed = JSON.parse(await file.text());
			if (parsed?.format !== 'datarover.cr/v1') {
				cr = null;
				errorMessage = 'Not a valid CR file (expected format datarover.cr/v1)';
				return;
			}
			cr = parsed as ChangeRequest;
			crFilename = file.name;
			errorMessage = null;
			result = null;
		} catch (err) {
			cr = null;
			errorMessage = err instanceof Error ? err.message : 'Invalid JSON';
		}
	}

	async function onApply(): Promise<void> {
		if (!model || !cr) {
			errorMessage = 'Choose both a model file and a CR file';
			return;
		}
		busy = true;
		result = null;
		errorMessage = null;
		try {
			const res = await applyCr(model, cr);
			result = res;
			if (res.ok) {
				await saveJsonToFile(res.model, modelFilename ?? 'model.json');
			}
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Apply failed';
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open {onOpenChange}>
	<Dialog.Content class="max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Apply change request</Dialog.Title>
			<Dialog.Description>
				Pick a model file and a CR file. The CR will be applied and the result saved as a new file.
			</Dialog.Description>
		</Dialog.Header>

		<div class="flex flex-col gap-3">
			<div class="flex items-center gap-2">
				<Button type="button" variant="outline" size="sm" onclick={() => modelInputRef?.click()}>
					Model file…
				</Button>
				<span class="truncate font-mono text-xs text-zinc-400">
					{modelFilename ?? 'No file selected'}
				</span>
				<input
					bind:this={modelInputRef}
					type="file"
					accept=".json"
					class="hidden"
					onchange={onModelSelected}
				/>
			</div>

			<div class="flex items-center gap-2">
				<Button type="button" variant="outline" size="sm" onclick={() => crInputRef?.click()}>
					CR file…
				</Button>
				<span class="truncate font-mono text-xs text-zinc-400">
					{crFilename ?? 'No file selected'}
				</span>
				<input
					bind:this={crInputRef}
					type="file"
					accept=".json"
					class="hidden"
					onchange={onCrSelected}
				/>
			</div>

			{#if errorMessage}
				<p class="text-xs text-red-400">{errorMessage}</p>
			{/if}

			{#if result && !result.ok}
				<div
					class="flex flex-col gap-1 rounded border border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-200"
					role="alert"
				>
					<p class="font-semibold">{result.conflicts.length} conflict(s) — nothing applied</p>
					{#each result.conflicts as c (c.id + c.kind)}
						<p class="font-mono">{c.entity} {c.id}: {c.kind} — {c.reason}</p>
					{/each}
				</div>
			{/if}

			{#if result && result.ok}
				<div
					class="rounded border border-emerald-900 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-200"
					role="status"
				>
					<p>Applied successfully. Saved to file.</p>
					{#if result.issues.length > 0}
						<p class="mt-1">{result.issues.length} validation issue(s):</p>
						{#each result.issues as issue (issue.message)}
							<p class="font-mono text-amber-300">{issue.severity}: {issue.message}</p>
						{/each}
					{/if}
				</div>
			{/if}
		</div>

		<Dialog.Footer>
			<Button type="button" variant="ghost" onclick={() => onOpenChange(false)} disabled={busy}>
				Close
			</Button>
			<Button type="button" onclick={onApply} disabled={busy || !model || !cr}>
				{busy ? 'Applying…' : 'Apply'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
