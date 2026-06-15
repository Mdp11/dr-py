<script lang="ts">
	import type { Element } from '$lib/api/types';
	import { indexIssues } from '$lib/state';
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
		EXCLUDED_SECTION_KEY,
		folderPathFromKey,
		isExcludedSectionKey,
		isFolderKey,
		type DndContext,
		type UnifiedTree,
		type Visibility
	} from './view-tree';
	import { createFolder, deleteFolder, renameFolder } from '$lib/state';
	import { elementDisplayName as displayName } from '$lib/util/element-name';

	type FolderOption = { path: string[]; label: string };

	type Props = {
		row: { key: string; parent: string | null; depth: number };
		tree: UnifiedTree;
		elementsById: Map<string, Element>;
		visibility: Map<string, Visibility>;
		collapsed: Set<string>;
		/** Containment child counts (server-reported) — drives expanders for
		 * element nodes whose children haven't been fetched yet. */
		childCounts: Map<string, number>;
		/** Count shown on the "Not in view" section header. */
		excludedTotal: number;
		folderOptions: FolderOption[];
		warningsByElementId: Set<string>;
		/** Prebuilt issue index, hoisted to the parent so it is built once per
		 * render rather than rebuilt for every windowed row. */
		issueIndex: ReturnType<typeof indexIssues>;
		selectedId: string | null;
		multiSelectedIds: Set<string>;
		focusedId?: string | null;
		/** The containing folder path for an element row, or null (top-level / under section). */
		parentFolderPath: string[] | null;
		/** This element's index within its folder's elements (for reorder). */
		siblingIndex: number;
		/** A folder row's element count (for append index). */
		folderLen: number;
		/** Whether this row is a draggable/movable element. */
		movable: boolean;
		dnd: DndContext;
		onToggle: (key: string) => void;
		onPick: (key: string, e: MouseEvent) => void;
		onMoveToFolder: (elementId: string, path: string[] | null) => Promise<void> | void;
	};

	let {
		row,
		tree,
		elementsById,
		visibility,
		collapsed,
		childCounts,
		excludedTotal,
		folderOptions,
		warningsByElementId,
		issueIndex,
		selectedId,
		multiSelectedIds,
		focusedId = null,
		parentFolderPath,
		siblingIndex,
		folderLen,
		movable,
		dnd,
		onToggle,
		onPick,
		onMoveToFolder
	}: Props = $props();

	const key = $derived(row.key);
	const depth = $derived(row.depth);

	const isExcludedSection = $derived(isExcludedSectionKey(key));
	const isFolder = $derived(isFolderKey(key));
	// folderPathFromKey throws for non-folder keys, so guard it.
	const folderPath = $derived(isFolder ? folderPathFromKey(key) : []);
	const folderName = $derived(
		isExcludedSection || isFolder ? (tree.folderName.get(key) ?? '') : ''
	);
	const placedInFolder = $derived(!isFolder && !isExcludedSection && tree.placedElementIds.has(key));
	const isMovable = $derived(movable);

	const el = $derived(isFolder || isExcludedSection ? undefined : elementsById.get(key));
	const allChildren = $derived(tree.children.get(key) ?? []);
	const myVisibility = $derived(visibility.get(key));
	// Folder/section: show the chevron when there are children to expand into.
	// Element: show it when there are loaded children OR an unfetched containment
	// level (server child_count > 0) so expanding can trigger the lazy fetch.
	const hasChildren = $derived(
		isFolder || isExcludedSection
			? myVisibility === 'full' && allChildren.length > 0
			: allChildren.length > 0 || (childCounts.get(key) ?? 0) > 0
	);
	const isCollapsed = $derived(collapsed.has(key));
	const isSelected = $derived(!isFolder && !isExcludedSection && selectedId === key);
	const isMultiSelected = $derived(!isFolder && !isExcludedSection && multiSelectedIds.has(key));
	const isFocused = $derived(focusedId === key);
	const isDropHover = $derived(dnd.hoverKey === key);
	const hasError = $derived(!isFolder && !isExcludedSection && issueIndex.errorIds.has(key));
	const hasModelWarning = $derived(
		!isFolder && !isExcludedSection && !hasError && issueIndex.warningIds.has(key)
	);
	const hasViewWarning = $derived(
		!isFolder && !isExcludedSection && warningsByElementId.has(key)
	);

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

{#if isExcludedSection}
	<div
		class="group flex h-6 select-none items-center gap-1 rounded px-1 py-0.5 text-zinc-200"
		class:ring-1={isFocused || isDropHover}
		class:ring-indigo-500={isFocused && !isDropHover}
		class:ring-emerald-500={isDropHover && dnd.hoverValid}
		class:ring-red-500={isDropHover && !dnd.hoverValid}
		class:bg-zinc-800={isDropHover}
		role="treeitem"
		tabindex={-1}
		aria-selected={false}
		aria-level={depth + 1}
		style="padding-left: {depth * 12 + 4}px"
		data-drop-key={EXCLUDED_SECTION_KEY}
		data-drop-kind="section"
		data-drop-path="null"
	>
		{#if hasChildren}
			<button
				type="button"
				class="flex h-4 w-4 shrink-0 items-center justify-center text-zinc-500 hover:text-zinc-200"
				onclick={() => onToggle(key)}
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
		<span class="flex-1 truncate font-medium" title={folderName}>
			{folderName}
		</span>
		<span class="font-mono text-[10px] text-zinc-500">{excludedTotal}</span>
	</div>
{:else if isFolder}
	<div
		class="group flex h-6 select-none items-center gap-1 rounded px-1 py-0.5 text-zinc-200"
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
		data-drop-key={key}
		data-drop-kind="folder"
		data-drop-path={JSON.stringify(folderPath)}
		data-folder-len={folderLen}
		onpointerdown={(e) => dnd.onPointerDown(e, key, 'folder', folderPath)}
	>
		{#if hasChildren}
			<button
				type="button"
				class="flex h-4 w-4 shrink-0 items-center justify-center text-zinc-500 hover:text-zinc-200"
				onclick={() => onToggle(key)}
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
{:else if el}
	<div
		class="group flex h-6 items-center gap-1 rounded px-1 py-0.5"
		class:bg-zinc-800={isSelected || isMultiSelected}
		class:ring-1={isFocused}
		class:ring-indigo-500={isFocused}
		role="treeitem"
		tabindex={-1}
		aria-selected={isSelected}
		aria-level={depth + 1}
		style="padding-left: {depth * 12 + 4}px; touch-action: {isMovable ? 'none' : 'auto'}"
		data-drop-key={key}
		data-drop-kind="element"
		data-drop-path={JSON.stringify(parentFolderPath)}
		data-sibling-index={siblingIndex}
		onpointerdown={(e) => dnd.onPointerDown(e, key, 'element', [])}
	>
		{#if hasChildren}
			<button
				type="button"
				class="flex h-4 w-4 shrink-0 items-center justify-center text-zinc-500 hover:text-zinc-200"
				onclick={() => onToggle(key)}
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
			onclick={(e) => onPick(key, e)}
			title={key}
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
							<DropdownMenu.Item onSelect={() => onMoveToFolder(key, opt.path)}>
								{opt.label}
							</DropdownMenu.Item>
						{/each}
						<DropdownMenu.Separator />
					{/if}
					{#if placedInFolder}
						<DropdownMenu.Item onSelect={() => onMoveToFolder(key, null)}>
							Remove from folder
						</DropdownMenu.Item>
					{/if}
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		{/if}
	</div>
{:else}
	<!-- Skeleton row: element body not fetched yet (windowed lazy load). -->
	<div
		class="flex h-6 items-center gap-1 rounded px-1 py-0.5"
		role="treeitem"
		tabindex={-1}
		aria-selected={false}
		aria-level={depth + 1}
		style="padding-left: {depth * 12 + 4}px"
		data-drop-key={key}
		data-drop-kind="element"
		data-drop-path={JSON.stringify(parentFolderPath)}
		data-sibling-index={siblingIndex}
	>
		<span class="flex h-4 w-4 shrink-0 items-center justify-center text-zinc-700">•</span>
		<span class="h-3 w-24 animate-pulse rounded bg-zinc-800"></span>
	</div>
{/if}
