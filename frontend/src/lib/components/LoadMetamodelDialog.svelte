<script lang="ts">
	import { metamodels, ApiError } from '$lib/api';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { createMutation, useQueryClient } from '@tanstack/svelte-query';

	type Props = {
		open: boolean;
		onUploaded?: (name: string) => void;
	};

	let { open = $bindable(false), onUploaded }: Props = $props();

	let name = $state('');
	let body = $state('');
	let errorMessage: string | null = $state(null);
	let fileInputRef: HTMLInputElement | null = $state(null);

	const queryClient = useQueryClient();

	const mutation = createMutation(() => ({
		mutationFn: async (vars: { name: string; body: string }) => {
			return await metamodels.putMetamodel(vars.name, vars.body);
		},
		onSuccess: async (_data: unknown, vars: { name: string; body: string }) => {
			await queryClient.invalidateQueries({ queryKey: ['metamodels'] });
			const uploadedName = vars.name;
			resetForm();
			open = false;
			onUploaded?.(uploadedName);
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
		name = '';
		body = '';
		errorMessage = null;
	}

	function onOpenChange(next: boolean): void {
		open = next;
		if (!next) {
			resetForm();
		}
	}

	async function onChooseFile(): Promise<void> {
		fileInputRef?.click();
	}

	async function onFileSelected(event: Event): Promise<void> {
		const target = event.target as HTMLInputElement;
		const file = target.files?.[0];
		if (!file) return;
		const text = await file.text();
		body = text;
		// Reset so picking the same file again still triggers change.
		target.value = '';
	}

	function onSubmit(event: SubmitEvent): void {
		event.preventDefault();
		errorMessage = null;
		const trimmedName = name.trim();
		if (!trimmedName) {
			errorMessage = 'Name is required';
			return;
		}
		if (!body) {
			errorMessage = 'Body is required';
			return;
		}
		mutation.mutate({ name: trimmedName, body });
	}
</script>

<Dialog.Root bind:open onOpenChange={onOpenChange}>
	<Dialog.Content class="max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>Upload metamodel</Dialog.Title>
			<Dialog.Description>
				Paste YAML or load a file. The contents are sent verbatim to the backend.
			</Dialog.Description>
		</Dialog.Header>
		<form onsubmit={onSubmit} class="flex flex-col gap-3">
			<div class="flex flex-col gap-1">
				<label for="metamodel-name" class="text-xs text-zinc-400">Name</label>
				<Input
					id="metamodel-name"
					bind:value={name}
					placeholder="example"
					autocomplete="off"
				/>
			</div>
			<div class="flex flex-col gap-1">
				<div class="flex items-center justify-between">
					<label for="metamodel-body" class="text-xs text-zinc-400">Body (YAML)</label>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						class="h-6 text-xs"
						onclick={onChooseFile}
					>
						Choose file...
					</Button>
					<input
						bind:this={fileInputRef}
						type="file"
						accept=".yaml,.yml,.json"
						class="hidden"
						onchange={onFileSelected}
					/>
				</div>
				<Textarea
					id="metamodel-body"
					bind:value={body}
					rows={16}
					class="font-mono text-xs"
					placeholder={'name: example\nelement_types: []\nrelationship_types: []'}
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
				<Button type="submit" disabled={mutation.isPending}>
					{mutation.isPending ? 'Uploading...' : 'Upload'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
