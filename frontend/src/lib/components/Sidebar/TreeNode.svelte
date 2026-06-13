<script lang="ts">
	import type { Element } from '$lib/api/types';
	import { getIssues, indexIssues } from '$lib/state';
	import {
		AlertCircle,
		AlertTriangle,
		ChevronDown,
		ChevronRight,
		Folder as FolderIcon,
		FolderOpen,
		MoreHorizontal
	} from '@lucide/svelte';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import {
		folderPathFromKey,
		isFolderKey,
		type DndContext,
		type UnifiedTree,
		type Visibility
	} from './view-tree';
	import { createFolder, deleteFolder, renameFolder } from '$lib/state';
	import { elementDisplayName as displayName } from '$lib/util/element-name';
	import Self from './TreeNode.svelte';

	type FolderOption = { path: string[]; label: string };

	type Props = {
		nodeKey: string;
		depth: number;
		tree: UnifiedTree;
		elementsById: Map<string, Element>;
		visibility: Map<string, Visibility>;
		collapsed: Set<string>;
		/** Containment child counts (server-reported) — drives expanders for
		 * element nodes whose children haven't been fetched yet. */
		childCounts: Map<string, number>;
		folderOptions: FolderOption[];
		warningsByElementId: Set<string>;
		selectedId: string | null;
		multiSelectedIds: Set<string>;
		focusedId?: string | null;
		dnd: DndContext;
		onToggle: (key: string) => void;
		onPick: (key: string, e: MouseEvent) => void;
		onMoveToFolder: (elementId: string, path: string[] | null) => Promise<void> | void;
	};

	let {
		nodeKey,
		depth,
		tree,
		elementsById,
		visibility,
		collapsed,
		childCounts,
		folderOptions,
		warningsByElementId,
		selectedId,
		multiSelectedIds,
		focusedId = null,
		dnd,
		onToggle,
		onPick,
		onMoveToFolder
	}: Props = $props();

	const isFolder = $derived(isFolderKey(nodeKey));
	const folderPath = $derived(isFolder ? folderPathFromKey(nodeKey) : []);
	const folderName = $derived(isFolder ? (tree.folderName.get(nodeKey) ?? '') : '');
	const placedInFolder = $derived(!isFolder && tree.placedElementIds.has(nodeKey));
	const isMovable = $derived(
		!isFolder && (tree.roots.includes(nodeKey) || tree.placedElementIds.has(nodeKey))
	);

	const el = $derived(isFolder ? undefined : elementsById.get(nodeKey));
	const allChildren = $derived(tree.children.get(nodeKey) ?? []);
	const myVisibility = $derived(visibility.get(nodeKey));
	const visibleChildren = $derived(
		myVisibility === 'full' ? allChildren.filter((c) => visibility.get(c) !== 'hidden') : []
	);
	// Element nodes can have an UNFETCHED containment level: the server-side
	// child_count says there are children even though none are loaded yet.
	// Show the expander so expanding can trigger the lazy fetch.
	const hasUnloadedChildren = $derived(
		!isFolder && allChildren.length === 0 && (childCounts.get(nodeKey) ?? 0) > 0
	);
	const hasChildren = $derived(visibleChildren.length > 0 || hasUnloadedChildren);
	const isCollapsed = $derived(collapsed.has(nodeKey));
	const isSelected = $derived(!isFolder && selectedId === nodeKey);
	const isMultiSelected = $derived(!isFolder && multiSelectedIds.has(nodeKey));
	const isFocused = $derived(focusedId === nodeKey);
	const isDropHover = $derived(dnd.hoverKey === nodeKey);
	const issueIndex = $derived(indexIssues(getIssues()));
	const hasError = $derived(!isFolder && issueIndex.errorIds.has(nodeKey));
	const hasModelWarning = $derived(!isFolder && !hasError && issueIndex.warningIds.has(nodeKey));
	const hasViewWarning = $derived(!isFolder && warningsByElementId.has(nodeKey));

	async function onNewFolder(): Promise<void> {
		const name = window.prompt('New folder name');
		if (name === null || name.trim() === '') return;
		try {
			await createFolder(folderPath, name.trim());
		} catch (err) {
			alert(err instanceof Error ? err.message : 'Failed to create folder');
		}
	}

	async function onRename(): Promise<void> {
		const next = window.prompt('Rename folder', folderName);
		if (next === null || next.trim() === '' || next.trim() === folderName) return;
		try {
			await renameFolder(folderPath, next.trim());
		} catch (err) {
			alert(err instanceof Error ? err.message : 'Failed to rename folder');
		}
	}

	async function onDelete(): Promise<void> {
		if (!window.confirm(`Delete folder "${folderName}" and its nested folders? Elements remain.`))
			return;
		try {
			await deleteFolder(folderPath);
		} catch (err) {
			alert(err instanceof Error ? err.message : 'Failed to delete folder');
		}
	}
</script>

{#if isFolder}
	<li>
		<div
			class="group flex select-none items-center gap-1 rounded px-1 py-0.5 text-zinc-200"
			class:ring-1={isFocused || isDropHover}
			class:ring-indigo-500={isFocused && !isDropHover}
			class:ring-emerald-500={isDropHover && dnd.hoverValid}
			class:ring-red-500={isDropHover && !dnd.hoverValid}
			class:bg-zinc-800={isDropHover}
			role="treeitem"
			tabindex={-1}
			aria-selected={false}
			aria-level={depth + 1}
			style="padding-left: {depth * 12 + 4}px; touch-action: none"
			data-drop-key={nodeKey}
			data-drop-path={JSON.stringify(folderPath)}
			onpointerdown={(e) => dnd.onPointerDown(e, nodeKey, 'folder', folderPath)}
		>
			{#if hasChildren}
				<button
					type="button"
					class="flex h-4 w-4 shrink-0 items-center justify-center text-zinc-500 hover:text-zinc-200"
					onclick={() => onToggle(nodeKey)}
					aria-label={isCollapsed ? 'Expand' : 'Collapse'}
				>
					{#if isCollapsed}
						<ChevronRight class="h-3 w-3" />
					{:else}
						<ChevronDown class="h-3 w-3" />
					{/if}
				</button>
			{:else}
				<span class="flex h-4 w-4 shrink-0 items-center justify-center text-zinc-700">·</span>
			{/if}
			<span class="flex h-4 w-4 shrink-0 items-center justify-center text-amber-300/80">
				{#if hasChildren && !isCollapsed}
					<FolderOpen class="h-3 w-3" />
				{:else}
					<FolderIcon class="h-3 w-3" />
				{/if}
			</span>
			<span class="flex-1 truncate font-medium" title={folderPath.join(' / ')}>
				{folderName}
			</span>
			{#if myVisibility === 'stub'}
				<span class="font-mono text-[10px] text-zinc-500">empty</span>
			{/if}
			<DropdownMenu.Root>
				<DropdownMenu.Trigger
					class="flex h-4 w-4 shrink-0 items-center justify-center rounded text-zinc-600 opacity-0 group-hover:opacity-100 hover:text-zinc-200"
					aria-label="Folder actions"
				>
					<MoreHorizontal class="h-3 w-3" />
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="end" class="w-44">
					<DropdownMenu.Item onSelect={onNewFolder}>New folder</DropdownMenu.Item>
					<DropdownMenu.Item onSelect={onRename}>Rename…</DropdownMenu.Item>
					<DropdownMenu.Separator />
					<DropdownMenu.Item onSelect={onDelete}>Delete</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		</div>
		{#if hasChildren && !isCollapsed}
			<ul class="flex flex-col">
				{#each visibleChildren as childKey (childKey)}
					<Self
						nodeKey={childKey}
						depth={depth + 1}
						{tree}
						{elementsById}
						{visibility}
						{collapsed}
						{childCounts}
						{folderOptions}
						{warningsByElementId}
						{selectedId}
						{multiSelectedIds}
						{focusedId}
						{dnd}
						{onToggle}
						{onPick}
						{onMoveToFolder}
					/>
				{/each}
			</ul>
		{/if}
	</li>
{:else if el}
	<li>
		<div
			class="group flex items-center gap-1 rounded px-1 py-0.5"
			class:bg-zinc-800={isSelected || isMultiSelected}
			class:ring-1={isFocused}
			class:ring-indigo-500={isFocused}
			role="treeitem"
			tabindex={-1}
			aria-selected={isSelected}
			aria-level={depth + 1}
			style="padding-left: {depth * 12 + 4}px; touch-action: {isMovable ? 'none' : 'auto'}"
			onpointerdown={(e) => dnd.onPointerDown(e, nodeKey, 'element', [])}
		>
			{#if hasChildren}
				<button
					type="button"
					class="flex h-4 w-4 shrink-0 items-center justify-center text-zinc-500 hover:text-zinc-200"
					onclick={() => onToggle(nodeKey)}
					aria-label={isCollapsed ? 'Expand' : 'Collapse'}
				>
					{#if isCollapsed}
						<ChevronRight class="h-3 w-3" />
					{:else}
						<ChevronDown class="h-3 w-3" />
					{/if}
				</button>
			{:else}
				<span class="flex h-4 w-4 shrink-0 items-center justify-center text-zinc-700">•</span>
			{/if}
			<button
				type="button"
				class="flex flex-1 items-center gap-2 truncate rounded text-left text-zinc-200 hover:text-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
				class:font-medium={isSelected}
				onclick={(e) => onPick(nodeKey, e)}
				title={nodeKey}
			>
				<span class="truncate">{displayName(el)}</span>
				<span class="ml-auto shrink-0 rounded bg-zinc-800 px-1 font-mono text-[10px] text-zinc-400">
					{el.type_name}
				</span>
				{#if hasError}
					<AlertCircle class="h-3 w-3 shrink-0 text-red-400" aria-label="has errors" />
				{:else if hasModelWarning || hasViewWarning}
					<AlertTriangle class="h-3 w-3 shrink-0 text-amber-400" aria-label="has warnings" />
				{/if}
			</button>
			{#if isMovable && (folderOptions.length > 0 || placedInFolder)}
				<DropdownMenu.Root>
					<DropdownMenu.Trigger
						class="flex h-4 w-4 shrink-0 items-center justify-center rounded text-zinc-600 opacity-0 group-hover:opacity-100 hover:text-zinc-200"
						aria-label="Element actions"
					>
						<MoreHorizontal class="h-3 w-3" />
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="end" class="w-56">
						{#if folderOptions.length > 0}
							<DropdownMenu.Label>Move to folder</DropdownMenu.Label>
							{#each folderOptions as opt (opt.label)}
								<DropdownMenu.Item onSelect={() => onMoveToFolder(nodeKey, opt.path)}>
									{opt.label}
								</DropdownMenu.Item>
							{/each}
							<DropdownMenu.Separator />
						{/if}
						{#if placedInFolder}
							<DropdownMenu.Item onSelect={() => onMoveToFolder(nodeKey, null)}>
								Remove from folder
							</DropdownMenu.Item>
						{/if}
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			{/if}
		</div>
		{#if hasChildren && !isCollapsed}
			<ul class="flex flex-col">
				{#each visibleChildren as childKey (childKey)}
					<Self
						nodeKey={childKey}
						depth={depth + 1}
						{tree}
						{elementsById}
						{visibility}
						{collapsed}
						{childCounts}
						{folderOptions}
						{warningsByElementId}
						{selectedId}
						{multiSelectedIds}
						{focusedId}
						{dnd}
						{onToggle}
						{onPick}
						{onMoveToFolder}
					/>
				{/each}
			</ul>
		{/if}
	</li>
{/if}
