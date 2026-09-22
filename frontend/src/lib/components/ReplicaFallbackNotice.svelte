<script lang="ts">
	import { slide } from 'svelte/transition';
	import { dur, PANEL } from '$lib/util/motion';
	import { Button } from '$lib/components/ui/button';
	import { dismissReplicaNotice } from '$lib/state';
</script>

<div
	class="col-span-5 flex items-center justify-between gap-3 bg-warning/15 px-3 py-1.5 text-xs text-warning"
	role="alert"
	data-testid="replica-notice"
	in:slide={{ duration: dur(PANEL) }}
>
	<span>
		The in-browser engine could not start — this tab reads from the server instead. Reload the page
		to try again.
	</span>
	<Button size="sm" variant="ghost" class="h-6 text-xs" onclick={() => dismissReplicaNotice()}>
		Dismiss
	</Button>
</div>
