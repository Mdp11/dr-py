<script lang="ts">
	import { ApiError } from '$lib/api';
	import { uploadModelBody } from '$lib/api/model-ops';
	import type { ModelSummary } from '$lib/api/types';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { createMutation } from '@tanstack/svelte-query';

	type Props = {
		open: boolean;
		onLoaded?: (summary: ModelSummary, filename: string) => void;
	};

	let { open = $bindable(false), onLoaded }: Props = $props();

	let filename: string | null = $state(null);
	let file: File | null = $state(null);
	let errorMessage: string | null = $state(null);
	let fileInputRef: HTMLInputElement | null = $state(null);

	const mutation = createMutation(() => ({
		mutationFn: async (vars: { file: File }) => {
			// stream the picked file as the raw request body — the model JSON is
			// parsed once, server-side (no file.text()/JSON.parse in the browser)
			return await uploadModelBody(vars.file);
		},
		onSuccess: (data: ModelSummary) => {
			const loadedFilename = filename ?? 'model.json';
			resetForm();
			open = false;
			onLoaded?.(data, loadedFilename);
		},
		onError: (err: unknown) => {
			if (err instanceof ApiError) {
				errorMessage = err.message;
			} else if (err instanceof Error) {
				errorMessage = err.message;
			} else {
				errorMessage = 'Load failed';
			}
		}
	}));

	function resetForm(): void {
		filename = null;
		file = null;
		errorMessage = null;
	}

	function onOpenChange(next: boolean): void {
		open = next;
		if (!next) {
			resetForm();
		}
	}

	function onChooseFile(): void {
		fileInputRef?.click();
	}

	function onFileSelected(event: Event): void {
		const target = event.target as HTMLInputElement;
		const picked = target.files?.[0];
		target.value = '';
		if (!picked) return;
		filename = picked.name;
		file = picked;
		errorMessage = null;
	}

	function onSubmit(event: SubmitEvent): void {
		event.preventDefault();
		errorMessage = null;
		if (!file) {
			errorMessage = 'Choose a model file';
			return;
		}
		mutation.mutate({ file });
	}
</script>

<Dialog.Root bind:open {onOpenChange}>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title>Load model</Dialog.Title>
			<Dialog.Description>
				Pick a JSON model file. It will be parsed against the active metamodel.
			</Dialog.Description>
		</Dialog.Header>
		<form onsubmit={onSubmit} class="flex flex-col gap-3">
			<div class="flex items-center gap-2">
				<Button type="button" variant="outline" size="sm" onclick={onChooseFile}>
					Choose file...
				</Button>
				<span class="truncate font-mono text-xs text-zinc-400">
					{filename ?? 'No file selected'}
				</span>
				<input
					bind:this={fileInputRef}
					type="file"
					accept=".json"
					class="hidden"
					onchange={onFileSelected}
				/>
			</div>
			{#if errorMessage}
				<p class="text-xs text-red-400">{errorMessage}</p>
			{/if}
			<Dialog.Footer>
				<Button
					type="button"
					variant="ghost"
					onclick={() => onOpenChange(false)}
					disabled={mutation.isPending}
				>
					Cancel
				</Button>
				<Button type="submit" disabled={mutation.isPending || !file}>
					{mutation.isPending ? 'Loading...' : 'Load'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
