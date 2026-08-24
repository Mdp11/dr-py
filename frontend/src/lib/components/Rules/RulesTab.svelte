<script lang="ts">
	// Placeholder for the validation_rules editor tab: the real editor does not
	// exist yet. Exists now only so the Workspace pane switch has something
	// real to import.
	let { tabId }: { tabId: string } = $props();
</script>

<div data-testid="rules-tab" data-tab-id={tabId}></div>
