<script lang="ts">
	import { ApiError } from '$lib/api';
	import { ViewSchema, type View } from '$lib/api/types';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { pushView } from '$lib/state';
	import { createMutation } from '@tanstack/svelte-query';

	type Props = {
		open: boolean;
		onLoaded?: (view: View, filename: string) => void;
	};

	let { open = $bindable(false), onLoaded }: Props = $props();

	let filename: string | null = $state(null);
	let body: View | null = $state(null);
	let errorMessage: string | null = $state(null);
	let fileInputRef: HTMLInputElement | null = $state(null);

	const mutation = createMutation(() => ({
		mutationFn: async (vars: { body: View }) => {
			return await pushView(vars.body);
		},
		onSuccess: (res: { view: View; warnings: unknown[] }) => {
			const loadedFilename = filename ?? 'view.json';
			resetForm();
			open = false;
			onLoaded?.(res.view, loadedFilename);
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
		if (!next) resetForm();
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
			body = ViewSchema.parse(parsed);
			errorMessage = null;
		} catch (err) {
			body = null;
			errorMessage = err instanceof Error ? err.message : 'Invalid view JSON';
		}
	}

	function onSubmit(event: SubmitEvent): void {
		event.preventDefault();
		errorMessage = null;
		if (!body) {
			errorMessage = 'Choose a view file';
			return;
		}
		mutation.mutate({ body });
	}
</script>

<Dialog.Root bind:open {onOpenChange}>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title>Load view</Dialog.Title>
			<Dialog.Description>
				Pick a JSON view file. It will be validated against the active model; missing elements or
				duplicate folder names appear as warnings.
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
