<script lang="ts">
	import { ChevronDown, Package } from '@lucide/svelte';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { canEdit, openExportArtifacts, openImportArtifacts } from '$lib/state';
	import ExportArtifactsDialog from './ExportArtifactsDialog.svelte';
	import ImportArtifactsDialog from './ImportArtifactsDialog.svelte';

	const editable = $derived(canEdit());
</script>

<DropdownMenu.Root>
	<DropdownMenu.Trigger
		data-testid="artifacts-menu-trigger"
		class="flex h-7 items-center gap-1 rounded px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
	>
		<Package class="h-3.5 w-3.5" />
		Artifacts
		<ChevronDown class="h-3 w-3" />
	</DropdownMenu.Trigger>
	<DropdownMenu.Content align="start" class="w-40">
		<DropdownMenu.Item onclick={() => openExportArtifacts()}>Export…</DropdownMenu.Item>
		{#if editable}
			<DropdownMenu.Item onclick={() => openImportArtifacts()}>Import…</DropdownMenu.Item>
		{/if}
	</DropdownMenu.Content>
</DropdownMenu.Root>

<ExportArtifactsDialog />
<ImportArtifactsDialog />
