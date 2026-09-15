<script lang="ts">
	// An element cell: the scope column's element, a navigation/script hit, or
	// an element-typed PROPERTY's reference. The last one may be editable —
	// `cell.element_id` is then the OWNER (patch target) and the cell renders
	// the Inspector's reference picker, staging the same `set_property`-shaped
	// `update_element` op `ValueCell` stages (`editLock` -> `emit`, never a
	// commit). `columnName` is threaded down from the definition exactly as
	// for `ValueCell`; without it the cell stays a plain link.
	import type { TableCell } from '$lib/api/types';
	import { canEdit, ensureElement, lockBadgeFor, select, type Op } from '$lib/state';
	import { editLock } from '$lib/state/edit-gate';
	import { emit, getStagedNameOverride, getStagedOpsFor } from '$lib/state/model.svelte';
	import ElementRefPicker from '$lib/components/Inspector/ElementRefPicker.svelte';

	let {
		cell,
		columnName
	}: {
		cell: Extract<TableCell, { kind: 'element' }>;
		columnName?: string;
	} = $props();

	// Staged overlay (ValueCell's rule, applied to the display name): an
	// uncommitted rename must win over the last-loaded page's display_name so
	// the scope column reflects the edit as immediately as the value cells do.
	const label = $derived(
		cell.item ? (getStagedNameOverride(cell.item.id) ?? cell.item.display_name) : ''
	);

	function isPropertyPatchOp(
		o: Op
	): o is Extract<Op, { kind: 'update_element' | 'update_relationship' }> {
		return o.kind === 'update_element' || o.kind === 'update_relationship';
	}

	const owner = $derived(cell.element_id ?? null);
	const lockedByPeer = $derived(owner !== null && lockBadgeFor(owner).state === 'theirs');
	const editable = $derived(
		cell.editable === true &&
			canEdit() &&
			!lockedByPeer &&
			!!columnName &&
			owner !== null &&
			!!cell.ref_type
	);

	// Staged-overlay for the reference itself: an in-flight edit to this
	// property wins over the page value (newest-first, like ValueCell).
	const stagedRef = $derived.by((): { value: string | null } | undefined => {
		if (owner === null || !columnName) return undefined;
		const ops = getStagedOpsFor(owner);
		for (let i = ops.length - 1; i >= 0; i--) {
			const o = ops[i];
			if (isPropertyPatchOp(o) && columnName in o.properties_patch) {
				const v = o.properties_patch[columnName];
				return { value: typeof v === 'string' ? v : null };
			}
		}
		return undefined;
	});
	const refId = $derived(stagedRef !== undefined ? stagedRef.value : (cell.item?.id ?? null));

	async function commitEdit(next: string | null): Promise<void> {
		if (owner === null || !columnName) return;
		// Same guarantee as ValueCell: load the owner first so the revert
		// journal is populated and the edit reaches the staged diff.
		const loaded = await ensureElement(owner);
		if (loaded === null) return;
		if (!(await editLock(owner))) return;
		emit({ kind: 'update_element', id: owner, properties_patch: { [columnName]: next } });
	}
</script>

{#if editable && cell.ref_type}
	<ElementRefPicker
		valueId={refId}
		targetTypeName={cell.ref_type}
		onChange={(id) => void commitEdit(id)}
	/>
{:else if cell.item}
	<button
		type="button"
		class="rounded bg-card px-1.5 py-0.5 text-left transition-colors hover:bg-muted"
		title={cell.item.type_name}
		onclick={() => cell.item && select({ kind: 'element', id: cell.item.id })}
	>
		{label}
	</button>
{:else}
	<span class="text-muted-foreground/50">—</span>
{/if}
