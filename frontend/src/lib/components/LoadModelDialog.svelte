<script lang="ts">
	import { model as modelApi, ApiError } from '$lib/api';
	import type { ModelOut, SnapshotIn } from '$lib/api/types';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { createMutation } from '@tanstack/svelte-query';

	type Props = {
		open: boolean;
		onLoaded?: (model: ModelOut, filename: string) => void;
	};

	let { open = $bindable(false), onLoaded }: Props = $props();

	let filename: string | null = $state(null);
	let body: SnapshotIn | null = $state(null);
	let errorMessage: string | null = $state(null);
	let fileInputRef: HTMLInputElement | null = $state(null);

	const mutation = createMutation(() => ({
		mutationFn: async (vars: { body: SnapshotIn }) => {
			return await modelApi.uploadModel(vars.body);
		},
		onSuccess: (data: ModelOut) => {
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
		body = null;
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

	async function onFileSelected(event: Event): Promise<void> {
		const target = event.target as HTMLInputElement;
		const file = target.files?.[0];
		target.value = '';
		if (!file) return;
		filename = file.name;
		try {
			const text = await file.text();
			const parsed = JSON.parse(text);
			body = {
				elements: parsed.elements ?? [],
				relationships: parsed.relationships ?? []
			};
			errorMessage = null;
		} catch (err) {
			body = null;
			errorMessage = err instanceof Error ? err.message : 'Invalid JSON';
		}
	}

	function onSubmit(event: SubmitEvent): void {
		event.preventDefault();
		errorMessage = null;
		if (!body) {
			errorMessage = 'Choose a model file';
			return;
		}
		mutation.mutate({ body });
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
				<Button type="submit" disabled={mutation.isPending || !body}>
					{mutation.isPending ? 'Loading...' : 'Load'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
