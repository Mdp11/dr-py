<script lang="ts">
	import { metamodel as metamodelApi, ApiError } from '$lib/api';
	import type { Metamodel } from '$lib/api/types';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { createMutation } from '@tanstack/svelte-query';

	type Props = {
		open: boolean;
		onUploaded?: (metamodel: Metamodel, filename: string) => void;
	};

	let { open = $bindable(false), onUploaded }: Props = $props();

	let filename: string | null = $state(null);
	let body: string | null = $state(null);
	let errorMessage: string | null = $state(null);
	let fileInputRef: HTMLInputElement | null = $state(null);

	const mutation = createMutation(() => ({
		mutationFn: async (vars: { body: string }) => {
			return await metamodelApi.uploadMetamodel(vars.body);
		},
		onSuccess: (data: Metamodel) => {
			const uploadedFilename = filename ?? 'metamodel';
			resetForm();
			open = false;
			onUploaded?.(data, uploadedFilename);
		},
		onError: (err: unknown) => {
			if (err instanceof ApiError) {
				errorMessage = err.message;
			} else if (err instanceof Error) {
				errorMessage = err.message;
			} else {
				errorMessage = 'Upload failed';
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
		body = await file.text();
		errorMessage = null;
	}

	function onSubmit(event: SubmitEvent): void {
		event.preventDefault();
		errorMessage = null;
		if (!body) {
			errorMessage = 'Choose a metamodel file';
			return;
		}
		mutation.mutate({ body });
	}
</script>

<Dialog.Root bind:open {onOpenChange}>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title>Load metamodel</Dialog.Title>
			<Dialog.Description>
				Pick a YAML or JSON file. Loading a metamodel discards the current model.
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
					accept=".yaml,.yml,.json"
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
