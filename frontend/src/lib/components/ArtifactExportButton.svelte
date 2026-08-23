<!-- ArtifactExportButton.svelte — the per-artifact bundle-export trigger,
     rendered inside each artifact editor's own toolbar. Hidden while the
     tab's artifact is a draft/temp id: the export dialog intersects with
     COMMITTED headers, so a staged-only artifact has nothing to export. -->
<script lang="ts">
	import { FileUp } from '@lucide/svelte';
	import { getDynamicTabs, openExportArtifacts } from '$lib/state';
	import { isTempId } from '$lib/state/ops';

	let { tabId }: { tabId: string } = $props();
	const tab = $derived(getDynamicTabs().find((t) => t.id === tabId) ?? null);
	const artifactId = $derived(tab?.artifactId ?? null);
	const exportable = $derived(artifactId !== null && !isTempId(artifactId));
</script>

{#if tab && artifactId !== null && exportable}
	<button
		type="button"
		data-testid="tab-export"
		aria-label={`Export ${tab.title}…`}
		title={`Export ${tab.title}…`}
		class="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
		onclick={() => openExportArtifacts([artifactId])}
	>
		<FileUp class="size-3.5" />
	</button>
{/if}
