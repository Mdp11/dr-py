<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { createProject } from '$lib/api/projects';
	import { endProgress, startProgress, updateProgress } from '$lib/state';

	let { open = $bindable(false), onCreated }: { open?: boolean; onCreated: (id: string) => void } =
		$props();

	let name = $state('');
	let metamodel = $state<File | null>(null);
	let model = $state<File | null>(null);
	let view = $state<File | null>(null);
	let error = $state<string | null>(null);
	let pending = $state(false);

	const canSubmit = $derived(name.trim().length > 0 && metamodel !== null);

	function pick(setter: (f: File | null) => void) {
		return (e: Event) => setter((e.target as HTMLInputElement).files?.[0] ?? null);
	}

	async function onSubmit(e: SubmitEvent): Promise<void> {
		e.preventDefault();
		if (!canSubmit || !metamodel) return;
		error = null;
		pending = true;
		const token = startProgress('Uploading project files…');
		try {
			const created = await createProject({ name, metamodel, model, view }, (loaded, total) => {
				if (total !== null && total > 0) updateProgress(token, loaded, total);
			});
			onCreated(created.id);
		} catch {
			error = 'Could not create the project. Check the metamodel file.';
		} finally {
			endProgress(token);
			pending = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-w-lg">
		<Dialog.Header>
			<Dialog.Title>New project</Dialog.Title>
			<Dialog.Description>
				Name the project and upload a metamodel. The model and view are optional — an empty model is
				created if you skip it.
			</Dialog.Description>
		</Dialog.Header>
		<form onsubmit={onSubmit} class="flex flex-col gap-3">
			<Input name="project-name" placeholder="Project name" bind:value={name} required />
			<label class="text-xs text-zinc-400">
				Metamodel (.yaml, required)
				<input
					data-testid="mm-input"
					type="file"
					accept=".yaml,.yml"
					class="mt-1 block text-xs"
					onchange={pick((f) => (metamodel = f))}
				/>
			</label>
			<label class="text-xs text-zinc-400">
				Model (.json, optional)
				<input
					data-testid="model-input"
					type="file"
					accept=".json"
					class="mt-1 block text-xs"
					onchange={pick((f) => (model = f))}
				/>
			</label>
			<label class="text-xs text-zinc-400">
				View (.json, optional)
				<input
					type="file"
					accept=".json"
					class="mt-1 block text-xs"
					onchange={pick((f) => (view = f))}
				/>
			</label>
			{#if error}
				<p class="text-xs text-red-400">{error}</p>
			{/if}
			<div class="flex justify-end gap-2">
				<Button type="submit" disabled={!canSubmit || pending}>
					{pending ? 'Creating…' : 'Create'}
				</Button>
			</div>
		</form>
	</Dialog.Content>
</Dialog.Root>
