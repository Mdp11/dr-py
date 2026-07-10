import { describe, expect, it } from 'vitest';
import { treeBodyState } from './tree-empty-state';
import { isProjectOpening, setProjectOpening } from '$lib/state/project-open.svelte';

const base = {
	opening: false,
	hasMetamodel: true,
	summaryCount: 5 as number | null,
	rootsLoaded: true,
	rootCount: 3
};

describe('treeBodyState', () => {
	it('paints rows whenever the tree has top-level nodes', () => {
		expect(treeBodyState(base)).toBe('rows');
		// even mid-open: view folders arriving before the summary are real content
		expect(treeBodyState({ ...base, opening: true, summaryCount: null })).toBe('rows');
	});

	it('shows onboarding text only when idle without a metamodel', () => {
		expect(treeBodyState({ ...base, hasMetamodel: false, rootCount: 0 })).toBe('onboarding');
	});

	it('shows a skeleton through every stage of a project open', () => {
		// before the metamodel lands
		expect(
			treeBodyState({
				opening: true,
				hasMetamodel: false,
				summaryCount: null,
				rootsLoaded: false,
				rootCount: 0
			})
		).toBe('skeleton');
		// metamodel + view in, summary still loading
		expect(
			treeBodyState({
				...base,
				opening: true,
				summaryCount: null,
				rootsLoaded: false,
				rootCount: 0
			})
		).toBe('skeleton');
		// summary in, first roots page still in flight (even after boot() returned)
		expect(treeBodyState({ ...base, rootsLoaded: false, rootCount: 0 })).toBe('skeleton');
		expect(treeBodyState({ ...base, opening: true, rootsLoaded: false, rootCount: 0 })).toBe(
			'skeleton'
		);
	});

	it('reports a known-empty model as empty, even mid-open', () => {
		expect(treeBodyState({ ...base, summaryCount: 0, rootCount: 0 })).toBe('empty');
		expect(
			treeBodyState({ ...base, opening: true, summaryCount: 0, rootsLoaded: false, rootCount: 0 })
		).toBe('empty');
	});

	it('treats a metamodel-only project (summary never loads) as empty once idle', () => {
		expect(treeBodyState({ ...base, summaryCount: null, rootsLoaded: false, rootCount: 0 })).toBe(
			'empty'
		);
	});

	it('renders the (blank) rows area when roots loaded but the filter hides everything', () => {
		expect(treeBodyState({ ...base, rootCount: 0 })).toBe('rows');
	});
});

describe('project-open store', () => {
	it('tracks the boot/reload-in-flight flag', () => {
		expect(isProjectOpening()).toBe(false);
		setProjectOpening(true);
		expect(isProjectOpening()).toBe(true);
		setProjectOpening(false);
		expect(isProjectOpening()).toBe(false);
	});
});
