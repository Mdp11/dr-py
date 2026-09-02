<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { addView, getAddViewOpen, setAddViewOpen } from '$lib/state';

	// Local mirror of the store's open flag, bound two-way to Dialog.Root (the
	// ImportArtifactsDialog idiom: bits-ui's own close round-trips through
	// onOpenChange, an external assignment does not re-trigger it).
	let open = $state(false);

	let name = $state('');
	let fileName = $state('');
	let doc = $state<Record<string, unknown> | null>(null);
	let parseError = $state<string | null>(null);
	let error = $state<string | null>(null);
	let busy = $state(false);
	let fileInputRef = $state<HTMLInputElement | null>(null);

	// Bumped on every open/close transition so an in-flight request that
	// settles after a close (or close-then-reopen) writes nothing.
	let gen = 0;

	$effect(() => {
		open = getAddViewOpen();
		gen++;
		reset();
	});

	function reset(): void {
		name = '';
		fileName = '';
		doc = null;
		parseError = null;
		error = null;
		busy = false;
	}

	async function onFilePicked(f: File | null | undefined): Promise<void> {
		if (!f) return;
		const g = gen;
		parseError = null;
		error = null;
		let parsed: unknown;
		try {
			parsed = JSON.parse(await f.text());
		} catch {
			if (g !== gen) return;
			parseError = 'Not a valid JSON file.';
			return;
		}
		if (g !== gen) return;
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
			parseError = 'A view document must be a JSON object.';
			return;
		}
		doc = parsed as Record<string, unknown>;
		fileName = f.name;
		// Prefill from the document's own name — the user's typed name wins.
		if (name.trim() === '' && typeof doc.name === 'string') name = doc.name;
	}

	function onDrop(e: DragEvent): void {
		e.preventDefault();
		void onFilePicked(e.dataTransfer?.files?.[0]);
	}

	const canSubmit = $derived(name.trim() !== '' && doc !== null && !busy);

	async function onSubmit(): Promise<void> {
		if (doc === null || name.trim() === '') return;
		const g = gen;
		busy = true;
		error = null;
		try {
			await addView(name.trim(), doc);
			if (g !== gen) return;
			setAddViewOpen(false);
		} catch (err) {
			if (g !== gen) return;
			// 409 duplicate name / 422 malformed document carry a `detail`
			// string the ApiError message already surfaces.
			error = err instanceof Error ? err.message : 'Could not add the view.';
		} finally {
			if (g === gen) busy = false;
		}
	}
</script>

<Dialog.Root bind:open onOpenChange={(v) => setAddViewOpen(v)}>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title class="font-display text-lg font-light tracking-wide">Add view</Dialog.Title>
			<Dialog.Description>
				Upload a view document (<code class="font-mono">*.view.json</code>) under a name that is
				unique in this project.
			</Dialog.Description>
		</Dialog.Header>

		<form
			class="flex flex-col gap-3"
			onsubmit={(e) => {
				e.preventDefault();
				void onSubmit();
			}}
		>
			<label class="flex flex-col gap-1 text-xs">
				<span class="text-muted-foreground">Name</span>
				<Input data-testid="add-view-name" bind:value={name} placeholder="Operational" />
			</label>
			<button
				type="button"
				class="flex flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border px-4 py-6 text-xs text-muted-foreground transition-colors hover:bg-muted"
				ondrop={onDrop}
				ondragover={(e) => e.preventDefault()}
				onclick={() => fileInputRef?.click()}
			>
				{#if fileName}
					<span class="font-mono text-foreground/90">{fileName}</span>
					<span>Click or drop to replace.</span>
				{:else}
					Drop a view file here, or click to choose one.
				{/if}
			</button>
			<input
				bind:this={fileInputRef}
				type="file"
				accept=".json"
				data-testid="add-view-file"
				class="hidden"
				onchange={(e) => {
					const input = e.currentTarget as HTMLInputElement;
					void onFilePicked(input.files?.[0]);
					// Re-picking the same filename after a parse error must fire again.
					input.value = '';
				}}
			/>
			{#if parseError}
				<p data-testid="add-view-parse-error" role="alert" class="text-xs text-destructive">
					{parseError}
				</p>
			{/if}
			{#if error}
				<p data-testid="add-view-error" role="alert" class="text-xs text-destructive">{error}</p>
			{/if}

			<Dialog.Footer>
				<Button type="button" variant="ghost" onclick={() => setAddViewOpen(false)}>Cancel</Button>
				<Button type="submit" data-testid="add-view-submit" disabled={!canSubmit}>Add</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
