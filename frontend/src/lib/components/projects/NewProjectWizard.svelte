<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { createProject } from '$lib/api/projects';
	import { ApiError } from '$lib/api/errors';
	import { beginJourney, journeyUpload, cancelJourney } from '$lib/state/open-journey';
	import FileSlot from './FileSlot.svelte';

	let {
		open = $bindable(false),
		onCreated
	}: { open?: boolean; onCreated: (id: string) => void | Promise<void> } = $props();

	let name = $state('');
	let metamodel = $state<File | null>(null);
	let model = $state<File | null>(null);
	let view = $state<File | null>(null);
	let error = $state<string | null>(null);
	let pending = $state(false);

	const canSubmit = $derived(name.trim().length > 0 && metamodel !== null);

	async function onSubmit(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		if (!canSubmit || !metamodel) return;
		error = null;
		pending = true;
		// Start the single journey bar now (on the click). It survives the goto()
		// into the workspace, where boot() adopts the same journey (beginJourney is
		// idempotent) and drives it through hydration/validation to 100%.
		beginJourney('create');
		try {
			const created = await createProject({ name, metamodel, model, view }, (loaded, total) => {
				journeyUpload(loaded, total);
			});
			// Do NOT end the journey here — boot() continues it after navigation.
			await onCreated(created.id);
		} catch (err) {
			cancelJourney(); // tear the bar down on failure
			error =
				err instanceof ApiError ? err.message : 'Could not create the project. Check the files.';
		} finally {
			pending = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="gap-0 p-0 sm:max-w-lg">
		<Dialog.Header class="px-6 pt-6">
			<Dialog.Title class="font-display text-lg font-light tracking-wide">New project</Dialog.Title>
			<Dialog.Description>
				A project starts from a metamodel. Add a model and view to import existing data, or skip
				them to start empty.
			</Dialog.Description>
		</Dialog.Header>
		<form onsubmit={onSubmit} class="flex flex-col">
			<div class="flex flex-col gap-5 px-6 py-5">
				<label class="flex flex-col gap-1.5">
					<span class="microlabel text-foreground/80">Project name</span>
					<Input name="project-name" placeholder="e.g. Smart City" bind:value={name} required />
				</label>
				<div class="flex flex-col gap-2">
					<FileSlot
						label="Metamodel"
						hint=".metamodel.yaml"
						accept=".yaml,.yml"
						required
						disabled={pending}
						testid="mm-input"
						bind:file={metamodel}
					/>
					<FileSlot
						label="Model"
						hint=".model.json"
						accept=".model.json"
						disabled={pending}
						testid="model-input"
						bind:file={model}
					/>
					<FileSlot
						label="View"
						hint=".view.json"
						accept=".view.json"
						disabled={pending}
						testid="view-input"
						bind:file={view}
					/>
				</div>
				{#if error}
					<p class="text-xs text-destructive" role="alert">{error}</p>
				{/if}
			</div>
			<Dialog.Footer class="border-t border-border bg-muted/30 px-6 py-4">
				<Button type="button" variant="ghost" onclick={() => (open = false)} disabled={pending}>
					Cancel
				</Button>
				<Button type="submit" disabled={!canSubmit || pending}>
					{pending ? 'Creating…' : 'Create project'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
