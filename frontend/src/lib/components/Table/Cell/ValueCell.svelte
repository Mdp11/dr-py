<script lang="ts">
	// Editable value cell (Task 6). Stages a `set_property`-shaped
	// `update_element` op through exactly the Inspector's checkout path
	// (`editLock` -> `emit`) — this component never commits. Commit happens
	// through the app-wide DiffDrawer once the op lands in the staged queue.
	//
	// `columnName` is the property name the cell's value came from. It isn't
	// on the evaluate response's column-out (`TableColumn` only carries
	// `kind`/`header`/`width_px`), so it's threaded down from the table
	// *definition* by the caller (TableGrid, which knows `definition.columns`).
	// A missing/empty `columnName` keeps the cell read-only defensively (no
	// patch key to write to).
	import type { TableCell } from '$lib/api/types';
	import { canEdit, lockBadgeFor, type Op } from '$lib/state';
	import { editLock } from '$lib/state/edit-gate';
	import { emit, getStagedOpsFor } from '$lib/state/model.svelte';

	let {
		cell,
		tabId,
		columnName
	}: {
		cell: Extract<TableCell, { kind: 'value' }>;
		tabId: string;
		columnName?: string;
	} = $props();

	// `tabId` isn't needed by the edit logic itself (edits target the element
	// directly via `emit`, not the table draft) but scopes the editor's DOM
	// id so cells for the same element/column stay unique across table tabs
	// (e.g. the same element opened in two table drafts at once).
	const inputId = $derived(`vc:${tabId}:${cell.element_id ?? ''}:${columnName ?? ''}`);

	function isPropertyPatchOp(
		o: Op
	): o is Extract<Op, { kind: 'update_element' | 'update_relationship' }> {
		return o.kind === 'update_element' || o.kind === 'update_relationship';
	}

	const lockedByPeer = $derived(
		cell.element_id !== null && lockBadgeFor(cell.element_id).state === 'theirs'
	);

	const editable = $derived(
		cell.editable && canEdit() && !lockedByPeer && !!columnName && cell.element_id !== null
	);

	// Staged-overlay: an in-flight (uncommitted) edit to this property should
	// win over the last-loaded page value so the cell reflects the edit
	// immediately. `stagedValue` is computed only inside the `columnName`
	// truthy guard, so the lookup key is a plain `string` (no cross-derivation
	// cast). It's wrapped in `{ value }` so a legitimately-staged `undefined`
	// (a property cleared to null/undefined) is distinguishable from "no
	// staged edit". Newest-first so the most recent staged patch wins if more
	// than one is queued for this column.
	const stagedValue = $derived.by((): { value: unknown } | undefined => {
		if (cell.element_id === null || !columnName) return undefined;
		const ops = getStagedOpsFor(cell.element_id);
		for (let i = ops.length - 1; i >= 0; i--) {
			const o = ops[i];
			if (isPropertyPatchOp(o) && columnName in o.properties_patch) {
				return { value: o.properties_patch[columnName] };
			}
		}
		return undefined;
	});

	const shown = $derived(stagedValue !== undefined ? stagedValue.value : cell.value);

	// Read-only text: the `cell.present` gate is exact per the brief (a
	// not-present cell renders empty, never a leftover staged value), while
	// `shown` stays staged-aware so a present, editable cell's fallback text
	// still reflects an in-flight edit.
	const text = $derived(cell.present ? String(shown ?? '') : '');

	async function commitEdit(next: unknown): Promise<void> {
		if (!cell.element_id || !columnName) return;
		if (!(await editLock(cell.element_id))) return;
		emit({ kind: 'update_element', id: cell.element_id, properties_patch: { [columnName]: next } });
	}

	function onNumberChange(e: Event): void {
		const raw = (e.currentTarget as HTMLInputElement).value;
		void commitEdit(raw === '' ? null : Number(raw));
	}
	function onBooleanChange(e: Event): void {
		void commitEdit((e.currentTarget as HTMLInputElement).checked);
	}
	function onTextChange(e: Event): void {
		void commitEdit((e.currentTarget as HTMLInputElement).value);
	}

	const inputCls =
		'h-6 w-full rounded border border-border bg-card px-1.5 text-xs text-foreground outline-none focus:border-ring';
</script>

{#if editable}
	{#if typeof shown === 'number'}
		<input id={inputId} type="number" class={inputCls} value={shown} onchange={onNumberChange} />
	{:else if typeof shown === 'boolean'}
		<input id={inputId} type="checkbox" checked={shown} onchange={onBooleanChange} />
	{:else}
		<input
			id={inputId}
			type="text"
			class={inputCls}
			value={typeof shown === 'string' ? shown : (shown ?? '')}
			onchange={onTextChange}
		/>
	{/if}
{:else}
	<span class:text-muted-foreground={!cell.present}>{text}</span>
{/if}
