<script lang="ts">
	import type { Element } from '$lib/api/types';
	import { artifactHeaderById, indexIssues, lockBadgeFor, openNavigationTab } from '$lib/state';
	import {
		AlertCircle,
		AlertTriangle,
		ChevronDown,
		ChevronRight,
		Folder as FolderIcon,
		FolderOpen,
		Lock,
		MoreHorizontal,
		Route,
		X
	} from '@lucide/svelte';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import {
		artifactIdFromKey,
		EXCLUDED_SECTION_KEY,
		folderPathFromKey,
		isArtifactKey,
		isExcludedSectionKey,
		isFolderKey,
		type DndContext,
		type UnifiedTree,
		type Visibility
	} from './view-tree';
	import { createFolder, deleteFolder, removeArtifactFromFolder, renameFolder } from '$lib/state';
	import { elementDisplayName as displayName } from '$lib/util/element-name';

	type FolderOption = { path: string[]; label: string };

	type Props = {
		row: { key: string; depth: number };
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
	const isArtifact = $derived(isArtifactKey(key));
	// folderPathFromKey throws for non-folder keys, so guard it.
	const folderPath = $derived(isFolder ? folderPathFromKey(key) : []);
	const artifactId = $derived(isArtifact ? artifactIdFromKey(key) : '');
	// Tolerate-dangling rule: an artifact id the library doesn't know about
	// (deleted elsewhere, or not yet loaded) renders nothing rather than an
	// error or skeleton — see the `{#if artifactHeader}` guard below.
	const artifactHeader = $derived(isArtifact ? artifactHeaderById(artifactId) : undefined);
	const folderName = $derived(
		isExcludedSection || isFolder ? (tree.folderName.get(key) ?? '') : ''
	);
	const placedInFolder = $derived(
		!isFolder && !isExcludedSection && tree.placedElementIds.has(key)
	);
	const isMovable = $derived(movable);

	const el = $derived(
		isFolder || isExcludedSection || isArtifact ? undefined : elementsById.get(key)
	);
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
	const hasViewWarning = $derived(!isFolder && !isExcludedSection && warningsByElementId.has(key));
	const badge = $derived(lockBadgeFor(key));

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

	function onOpenArtifact(): void {
		if (!artifactHeader) return;
		openNavigationTab({ artifactId, title: artifactHeader.name });
	}

	async function onRemoveArtifact(e: MouseEvent): Promise<void> {
		e.stopPropagation(); // don't also fire the row's dblclick-to-open
		if (parentFolderPath === null) return;
		try {
			await removeArtifactFromFolder(parentFolderPath, artifactId);
		} catch (err) {
			console.error('Remove artifact failed', err);
		}
	}
</script>

{#if isExcludedSection}
	<div
		class="group flex h-6 select-none items-center gap-1 rounded px-1 py-0.5 text-foreground/90"
		class:ring-1={isFocused || isDropHover}
		class:ring-ring={isFocused && !isDropHover}
		class:ring-success={isDropHover && dnd.hoverValid}
		class:ring-destructive={isDropHover && !dnd.hoverValid}
		class:bg-muted={isDropHover}
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
				class="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground/70 transition-colors hover:text-foreground"
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
			<span class="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground/40"
				>·</span
			>
		{/if}
		<span class="flex h-4 w-4 shrink-0 items-center justify-center text-warning/80">
			{#if hasChildren && !isCollapsed}
				<FolderOpen class="h-3 w-3" />
			{:else}
				<FolderIcon class="h-3 w-3" />
			{/if}
		</span>
		<span class="flex-1 truncate font-medium" title={folderName}>
			{folderName}
		</span>
		<span class="font-mono text-[10px] text-muted-foreground/70">{excludedTotal}</span>
	</div>
{:else if isFolder}
	<div
		class="group flex h-6 select-none items-center gap-1 rounded px-1 py-0.5 text-foreground/90"
		class:ring-1={isFocused || isDropHover}
		class:ring-ring={isFocused && !isDropHover}
		class:ring-success={isDropHover && dnd.hoverValid}
		class:ring-destructive={isDropHover && !dnd.hoverValid}
		class:bg-muted={isDropHover}
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
				class="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground/70 transition-colors hover:text-foreground"
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
			<span class="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground/40"
				>·</span
			>
		{/if}
		<span class="flex h-4 w-4 shrink-0 items-center justify-center text-warning/80">
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
			<span class="font-mono text-[10px] text-muted-foreground/70">empty</span>
		{/if}
		<DropdownMenu.Root>
			<DropdownMenu.Trigger
				class="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground/50 opacity-0 transition-colors group-hover:opacity-100 hover:text-foreground"
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
{:else if isArtifact}
	{#if artifactHeader}
		<div
			class="group flex h-6 select-none items-center gap-1 rounded px-1 py-0.5 text-foreground/90"
			class:ring-1={isFocused}
			class:ring-ring={isFocused}
			role="treeitem"
			tabindex={-1}
			aria-selected={false}
			aria-level={depth + 1}
			style="padding-left: {depth * 12 + 4}px; touch-action: none"
			ondblclick={onOpenArtifact}
			onpointerdown={(e) => dnd.onPointerDown(e, key, 'artifact', parentFolderPath ?? [])}
		>
			<span class="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground/40"
				>·</span
			>
			<span class="flex h-4 w-4 shrink-0 items-center justify-center text-info">
				<Route class="h-3 w-3" />
			</span>
			<span class="flex-1 truncate" title={artifactHeader.name}>
				{artifactHeader.name}
			</span>
			<button
				type="button"
				class="hidden h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground/50 opacity-0 transition-colors hover:text-destructive group-hover:flex group-hover:opacity-100"
				aria-label="Remove from folder"
				title="Remove from folder"
				onclick={onRemoveArtifact}
			>
				<X class="h-3 w-3" />
			</button>
		</div>
	{:else}
		<!-- Dangling ref: the artifact library doesn't know this id (deleted
		     elsewhere, or the library hasn't loaded yet). Tolerate-don't-prune —
		     never auto-removed on load — but still visible (not a blank windowing
		     slot) and still removable so a user can clean it up. No dblclick-open
		     (nothing to open) and not draggable (no onpointerdown wiring). -->
		<div
			class="group flex h-6 select-none items-center gap-1 rounded px-1 py-0.5 text-muted-foreground/50"
			class:ring-1={isFocused}
			class:ring-ring={isFocused}
			role="treeitem"
			tabindex={-1}
			aria-selected={false}
			aria-level={depth + 1}
			style="padding-left: {depth * 12 + 4}px"
		>
			<span class="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground/40"
				>·</span
			>
			<span class="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground/40">
				<Route class="h-3 w-3" />
			</span>
			<span class="flex-1 truncate italic" title={artifactId}>
				(missing artifact) {artifactId}
			</span>
			<button
				type="button"
				class="hidden h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground/50 opacity-0 transition-colors hover:text-destructive group-hover:flex group-hover:opacity-100"
				aria-label="Remove from folder"
				title="Remove from folder"
				onclick={onRemoveArtifact}
			>
				<X class="h-3 w-3" />
			</button>
		</div>
	{/if}
{:else if el}
	<div
		class="group flex h-6 items-center gap-1 rounded px-1 py-0.5 {isSelected || isMultiSelected
			? 'bg-primary/15'
			: ''}"
		class:ring-1={isFocused}
		class:ring-ring={isFocused}
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
				class="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground/70 transition-colors hover:text-foreground"
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
			<span class="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground/40"
				>•</span
			>
		{/if}
		<button
			type="button"
			class="flex flex-1 items-center gap-2 rounded text-left text-foreground/90 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			class:font-medium={isSelected}
			class:text-foreground={isSelected}
			onclick={(e) => onPick(key, e)}
			title={key}
		>
			<span class="whitespace-nowrap">{displayName(el)}</span>
			<span
				class="ml-auto shrink-0 rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground"
			>
				{el.type_name}
			</span>
			{#if hasError}
				<AlertCircle class="h-3 w-3 shrink-0 text-destructive" aria-label="has errors" />
			{:else if hasModelWarning || hasViewWarning}
				<AlertTriangle class="h-3 w-3 shrink-0 text-warning" aria-label="has warnings" />
			{/if}
		</button>
		{#if badge.state === 'theirs'}
			<Lock class="h-3 w-3 shrink-0 text-warning" title={`Locked by ${badge.holder}`} />
		{:else if badge.state === 'mine'}
			<Lock class="h-3 w-3 shrink-0 text-success" title="Checked out by you" />
		{/if}
		{#if isMovable && (folderOptions.length > 0 || placedInFolder)}
			<DropdownMenu.Root>
				<DropdownMenu.Trigger
					class="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground/50 opacity-0 transition-colors group-hover:opacity-100 hover:text-foreground"
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
		<span class="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground/40">•</span
		>
		<span class="h-3 w-24 animate-pulse rounded bg-muted"></span>
	</div>
{/if}
