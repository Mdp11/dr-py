<script lang="ts">
	import { ChevronDown, FolderTree } from '@lucide/svelte';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import {
		canEdit,
		getActiveViewId,
		getViews,
		openAddView,
		openDeleteView,
		selectView,
		setAddViewOpen,
		setDeleteViewOpen
	} from '$lib/state';
	import AddViewDialog from './AddViewDialog.svelte';
	import DeleteViewDialog from './DeleteViewDialog.svelte';

	const editable = $derived(canEdit());
	const views = $derived(getViews());
	const activeId = $derived(getActiveViewId());

	// This menu is the ONLY place the add/delete dialogs mount, but their
	// open flags are module state — so this component owns the flags'
	// lifecycle, exactly as ArtifactsMenu does for the artifact dialogs:
	// cleared in INIT (a flag latched while no dialog was mounted must not pop
	// one open on project entry) and again on the way OUT (browser Back with
	// a dialog open must not carry the flag into the next project entry).
	setAddViewOpen(false);
	setDeleteViewOpen(false);

	$effect(() => {
		return () => {
			setAddViewOpen(false);
			setDeleteViewOpen(false);
		};
	});
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger
		data-testid="view-menu-trigger"
		class="flex h-7 items-center gap-1 rounded px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
	>
		<FolderTree class="h-3.5 w-3.5" />
		View
		<ChevronDown class="h-3 w-3" />
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="start" class="w-52">
		{#if views.length === 0}
			<DropdownMenu.Item disabled>No views</DropdownMenu.Item>
		{:else}
			<DropdownMenu.RadioGroup
				value={activeId ?? ''}
				onValueChange={(id) => {
					if (id !== '') void selectView(id);
				}}
			>
				{#each views as v (v.id)}
					<DropdownMenu.RadioItem value={v.id} data-testid={`view-menu-item-${v.id}`}>
						<span class="truncate">{v.name}</span>
					</DropdownMenu.RadioItem>
				{/each}
			</DropdownMenu.RadioGroup>
		{/if}
		{#if editable}
			<DropdownMenu.Separator />
			<DropdownMenu.Item onclick={() => openAddView()}>Add view…</DropdownMenu.Item>
			<DropdownMenu.Item disabled={views.length === 0} onclick={() => openDeleteView()}>
				Delete view…
			</DropdownMenu.Item>
		{/if}
	</DropdownMenu.Content>
</DropdownMenu.Root>

<AddViewDialog />
<DeleteViewDialog />
