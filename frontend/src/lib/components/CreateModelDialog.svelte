<script lang="ts">
	import { metamodels as metamodelsApi, models as modelsApi, ApiError } from '$lib/api';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';

	type Props = {
		open: boolean;
		defaultMetamodel?: string | null;
		onCreated?: (name: string) => void;
	};

	let {
		open = $bindable(false),
		defaultMetamodel = null,
		onCreated
	}: Props = $props();

	let name = $state('');
	let metamodel: string = $state('');
	let errorMessage: string | null = $state(null);

	const queryClient = useQueryClient();

	const metamodelsQuery = createQuery(() => ({
		queryKey: ['metamodels'],
		queryFn: () => metamodelsApi.listMetamodels()
	}));

	// Initialise/sync the selected metamodel from props when the dialog opens.
	$effect(() => {
		if (open) {
			if (!metamodel && defaultMetamodel) {
				metamodel = defaultMetamodel;
			}
		}
	});

	const mutation = createMutation(() => ({
		mutationFn: async (vars: { name: string; metamodel: string }) => {
			return await modelsApi.createModel({ name: vars.name, metamodel: vars.metamodel });
		},
		onSuccess: async (_data: unknown, vars: { name: string; metamodel: string }) => {
			await queryClient.invalidateQueries({ queryKey: ['models'] });
			const createdName = vars.name;
			resetForm();
			open = false;
			onCreated?.(createdName);
		},
		onError: (err: unknown) => {
			if (err instanceof ApiError) {
				errorMessage = err.message;
			} else if (err instanceof Error) {
				errorMessage = err.message;
			} else {
				errorMessage = 'Create failed';
			}
		}
	}));

	function resetForm(): void {
		name = '';
		metamodel = defaultMetamodel ?? '';
		errorMessage = null;
	}

	function onOpenChange(next: boolean): void {
		open = next;
		if (!next) {
			resetForm();
		}
	}

	function onSubmit(event: SubmitEvent): void {
		event.preventDefault();
		errorMessage = null;
		const trimmedName = name.trim();
		const trimmedMetamodel = metamodel.trim();
		if (!trimmedName) {
			errorMessage = 'Name is required';
			return;
		}
		if (!trimmedMetamodel) {
			errorMessage = 'Metamodel is required';
			return;
		}
		mutation.mutate({ name: trimmedName, metamodel: trimmedMetamodel });
	}
</script>

<Dialog.Root bind:open onOpenChange={onOpenChange}>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title>Create model</Dialog.Title>
			<Dialog.Description>
				Create an empty model bound to a metamodel.
			</Dialog.Description>
		</Dialog.Header>
		<form onsubmit={onSubmit} class="flex flex-col gap-3">
			<div class="flex flex-col gap-1">
				<label for="model-name" class="text-xs text-zinc-400">Name</label>
				<Input
					id="model-name"
					bind:value={name}
					placeholder="demo"
					autocomplete="off"
				/>
			</div>
			<div class="flex flex-col gap-1">
				<label for="model-metamodel" class="text-xs text-zinc-400">Metamodel</label>
				<select
					id="model-metamodel"
					bind:value={metamodel}
					class="border-input bg-transparent dark:bg-input/30 rounded-md border px-2.5 py-1.5 text-sm shadow-xs outline-none"
				>
					<option value="" disabled>Select a metamodel...</option>
					{#each metamodelsQuery.data ?? [] as mm (mm)}
						<option value={mm}>{mm}</option>
					{/each}
				</select>
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
					{mutation.isPending ? 'Creating...' : 'Create'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
