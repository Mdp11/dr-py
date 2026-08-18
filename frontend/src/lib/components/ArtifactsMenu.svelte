<script lang="ts">
	import { ChevronDown, Package } from '@lucide/svelte';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import {
		canEdit,
		openExportArtifacts,
		openImportArtifacts,
		setExportArtifactsOpen,
		setImportArtifactsOpen
	} from '$lib/state';
	import ExportArtifactsDialog from './ExportArtifactsDialog.svelte';
	import ImportArtifactsDialog from './ImportArtifactsDialog.svelte';

	const editable = $derived(canEdit());

	// This menu is the ONLY place the export/import dialogs mount, but their
	// open flags are module state writable from anywhere (the per-tab export
	// button) — so this component owns the flags' lifecycle. Clearing them
	// here in INIT (synchronously, before the child dialogs below are even
	// created) guarantees a flag latched while no dialog was mounted cannot
	// pop a dialog open on project entry; no legitimate flow opens these
	// dialogs before this menu mounts.
	setExportArtifactsOpen(false);
	setImportArtifactsOpen(false);

	// …and clear them again on the way OUT: leaving the workspace with a
	// dialog open (browser Back) must not carry the open flag into the next
	// project entry.
	$effect(() => {
		return () => {
			setExportArtifactsOpen(false);
			setImportArtifactsOpen(false);
		};
	});
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
