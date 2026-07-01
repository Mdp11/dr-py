<script lang="ts">
	import type { Element, PropertyDef, Relationship } from '$lib/api/types';
	import { effectiveProperties, effectiveRelationshipProperties } from '$lib/metamodel/helpers';
	import { emit, getMetamodel, lockBadgeFor } from '$lib/state';
	import { editLock } from '$lib/state/edit-gate';
	import PropertyField from './PropertyField.svelte';

	type Props = {
		entity: Element | Relationship;
		kind: 'element' | 'relationship';
	};

	let { entity, kind }: Props = $props();

	const mm = $derived(getMetamodel());

	// A peer holds this entity's lock: the edit would be rejected server-side
	// (and silently dropped), so make the whole form read-only rather than let
	// the user type changes that will be lost. `editLock` still guards the
	// emit path as defense-in-depth.
	const peerLock = $derived(lockBadgeFor(entity.id));
	const lockedByOther = $derived(peerLock.state === 'theirs');

	const propDefs = $derived.by((): PropertyDef[] => {
		if (mm === null) return [];
		return kind === 'element'
			? effectiveProperties(mm, entity.type_name)
			: effectiveRelationshipProperties(mm, entity.type_name);
	});

	async function onPropChange(name: string, next: unknown): Promise<void> {
		if (!(await editLock(entity.id))) return; // locked by someone / viewer
		if (kind === 'element') {
			emit({
				kind: 'update_element',
				id: entity.id,
				properties_patch: { [name]: next }
			});
		} else {
			emit({
				kind: 'update_relationship',
				id: entity.id,
				properties_patch: { [name]: next }
			});
		}
	}
</script>

<div class="flex flex-col gap-3">
	<div>
		<span
			class="inline-block rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400"
			title={entity.id}
		>
			{entity.id}
		</span>
	</div>
	{#if lockedByOther}
		<p data-testid="readonly-notice" class="text-[10px] text-amber-500/80">
			Locked by {peerLock.holder ?? 'another user'} — read-only
		</p>
	{/if}
	{#if propDefs.length === 0}
		<p class="text-xs italic text-zinc-500">(no properties defined)</p>
	{:else}
		<!-- `disabled` on the fieldset natively disables every descendant form
		     control (inputs, selects, textareas, and the pickers' buttons), so a
		     peer-locked entity cannot be edited from either the Inspector or the
		     DetailView. min-w-0/border-0/p-0/m-0 strip the fieldset's default box. -->
		<fieldset disabled={lockedByOther} class="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
			{#each propDefs as pd (pd.name)}
				<PropertyField
					propDef={pd}
					value={entity.properties[pd.name]}
					onChange={(next) => onPropChange(pd.name, next)}
				/>
			{/each}
		</fieldset>
	{/if}
</div>
