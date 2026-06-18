<script lang="ts">
	import type { Element, PropertyDef, Relationship } from '$lib/api/types';
	import { effectiveProperties, effectiveRelationshipProperties } from '$lib/metamodel/helpers';
	import { emit, getMetamodel } from '$lib/state';
	import { editLock } from '$lib/state/edit-gate';
	import PropertyField from './PropertyField.svelte';

	type Props = {
		entity: Element | Relationship;
		kind: 'element' | 'relationship';
	};

	let { entity, kind }: Props = $props();

	const mm = $derived(getMetamodel());

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
	{#if propDefs.length === 0}
		<p class="text-xs italic text-zinc-500">(no properties defined)</p>
	{:else}
		<div class="flex flex-col gap-3">
			{#each propDefs as pd (pd.name)}
				<PropertyField
					propDef={pd}
					value={entity.properties[pd.name]}
					onChange={(next) => onPropChange(pd.name, next)}
				/>
			{/each}
		</div>
	{/if}
</div>
