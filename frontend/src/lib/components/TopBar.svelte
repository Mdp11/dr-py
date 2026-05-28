<script lang="ts">
	import { metamodels as metamodelsApi, models as modelsApi } from '$lib/api';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import {
		getBaseline,
		getMetamodelName,
		getPendingOps,
		resetOps,
		setBaseline,
		setMetamodel
	} from '$lib/state';
	import { createQuery, useQueryClient } from '@tanstack/svelte-query';
	import { ChevronDown } from '@lucide/svelte';
	import LoadMetamodelDialog from './LoadMetamodelDialog.svelte';
	import CreateModelDialog from './CreateModelDialog.svelte';

	let uploadDialogOpen = $state(false);
	let createModelDialogOpen = $state(false);

	const queryClient = useQueryClient();

	const metamodelsListQuery = createQuery(() => ({
		queryKey: ['metamodels'],
		queryFn: () => metamodelsApi.listMetamodels()
	}));

	const modelsListQuery = createQuery(() => ({
		queryKey: ['models'],
		queryFn: () => modelsApi.listModels()
	}));

	const selectedMetamodel = $derived(getMetamodelName());
	const baseline = $derived(getBaseline());
	const filteredModels = $derived(
		(modelsListQuery.data ?? []).filter(
			(m) => selectedMetamodel === null || m.metamodel === selectedMetamodel
		)
	);

	async function selectMetamodel(name: string): Promise<void> {
		try {
			const mm = await queryClient.fetchQuery({
				queryKey: ['metamodels', name],
				queryFn: () => metamodelsApi.getMetamodel(name)
			});
			setMetamodel(name, mm);
		} catch (err) {
			console.error('Failed to load metamodel', name, err);
		}
	}

	async function selectModel(name: string): Promise<void> {
		if (getPendingOps().length > 0) {
			const ok = window.confirm(
				'You have unsaved changes that will be discarded. Continue?'
			);
			if (!ok) return;
		}
		try {
			const model = await queryClient.fetchQuery({
				queryKey: ['models', name],
				queryFn: () => modelsApi.getModel(name)
			});
			setBaseline(model);
			resetOps();
		} catch (err) {
			console.error('Failed to load model', name, err);
		}
	}

	function onMetamodelUploaded(name: string): void {
		void selectMetamodel(name);
	}

	function onModelCreated(name: string): void {
		void selectModel(name);
	}
</script>

<header
	class="sticky top-0 z-20 col-span-3 flex h-10 items-center justify-between border-b border-zinc-800 bg-zinc-950 px-3 text-sm"
>
	<div class="flex items-center gap-3">
		<span class="font-semibold tracking-tight text-zinc-100">Data Rover</span>

		<div class="flex items-center gap-1">
			<span class="text-xs text-zinc-500">Metamodel:</span>
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="ghost"
							size="sm"
							class="h-7 gap-1 text-xs"
						>
							<span class="font-mono">
								{selectedMetamodel ?? 'Metamodel'}
							</span>
							<ChevronDown class="h-3 w-3" />
						</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="start" class="min-w-48">
					{#if metamodelsListQuery.isLoading}
						<DropdownMenu.Label class="text-xs text-zinc-500">Loading...</DropdownMenu.Label>
					{:else if (metamodelsListQuery.data ?? []).length === 0}
						<DropdownMenu.Label class="text-xs text-zinc-500">
							No metamodels
						</DropdownMenu.Label>
					{:else}
						{#each metamodelsListQuery.data ?? [] as mm (mm)}
							<DropdownMenu.Item onSelect={() => selectMetamodel(mm)}>
								<span class="font-mono text-xs">{mm}</span>
								{#if mm === selectedMetamodel}
									<span class="ml-auto text-xs text-zinc-500">●</span>
								{/if}
							</DropdownMenu.Item>
						{/each}
					{/if}
					<DropdownMenu.Separator />
					<DropdownMenu.Item onSelect={() => (uploadDialogOpen = true)}>
						<span class="text-xs">Upload new...</span>
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		</div>

		<div class="flex items-center gap-1">
			<span class="text-xs text-zinc-500">Model:</span>
			<DropdownMenu.Root>
				<DropdownMenu.Trigger disabled={selectedMetamodel === null}>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="ghost"
							size="sm"
							class="h-7 gap-1 text-xs"
							disabled={selectedMetamodel === null}
						>
							<span class="font-mono">
								{baseline?.name ?? 'Model'}
							</span>
							<ChevronDown class="h-3 w-3" />
						</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="start" class="min-w-48">
					{#if selectedMetamodel === null}
						<DropdownMenu.Label class="text-xs text-zinc-500">
							Select a metamodel first
						</DropdownMenu.Label>
					{:else if modelsListQuery.isLoading}
						<DropdownMenu.Label class="text-xs text-zinc-500">Loading...</DropdownMenu.Label>
					{:else if filteredModels.length === 0}
						<DropdownMenu.Label class="text-xs text-zinc-500">
							(no models — Create new model...)
						</DropdownMenu.Label>
					{:else}
						{#each filteredModels as m (m.name)}
							<DropdownMenu.Item onSelect={() => selectModel(m.name)}>
								<span class="font-mono text-xs">{m.name}</span>
								{#if m.name === baseline?.name}
									<span class="ml-auto text-xs text-zinc-500">●</span>
								{/if}
							</DropdownMenu.Item>
						{/each}
					{/if}
					<DropdownMenu.Separator />
					<DropdownMenu.Item
						disabled={selectedMetamodel === null}
						onSelect={() => (createModelDialogOpen = true)}
					>
						<span class="text-xs">Create new model...</span>
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		</div>
	</div>

	<div class="flex items-center gap-2">
		<Button variant="ghost" size="sm" class="h-7 text-xs">Validate</Button>
		<Button variant="ghost" size="sm" class="h-7 text-xs">Save</Button>
		<span class="font-mono text-xs text-zinc-400">● 0 changes</span>
	</div>
</header>

<LoadMetamodelDialog bind:open={uploadDialogOpen} onUploaded={onMetamodelUploaded} />
<CreateModelDialog
	bind:open={createModelDialogOpen}
	defaultMetamodel={selectedMetamodel}
	onCreated={onModelCreated}
/>
