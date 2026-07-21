<script lang="ts">
	// A script cell the backend hasn't computed yet: `/tables/evaluate` runs
	// cache-only and returns `{kind:'pending'}` for values the background sweep
	// is still filling in (the table's `script_status` is `computing`, and the
	// store is polling for the finished page).
	//
	// Deliberately the SAME visual language as the grid's un-fetched ROW
	// placeholder (`animate-pulse rounded bg-muted` bar in TableGrid) — both mean
	// "this is on its way", so they should not look like two different states.
</script>

<div
	data-testid="pending-cell"
	class="flex h-7 max-w-full min-w-0 items-center"
	aria-label="computing"
	title="This value is still being computed"
>
	<div class="h-3 w-3/5 animate-pulse rounded bg-muted"></div>
</div>
