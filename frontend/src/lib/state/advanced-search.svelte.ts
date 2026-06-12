// Advanced-search UI + draft-query state. Accessor-function convention,
// matching the other *.svelte.ts stores. The query model and evaluation
// live in $lib/search; this store only holds editable/committed state.

import {
	criteriaForKind,
	newCriterion,
	pruneCriteria,
	type AdvancedQuery,
	type Criterion,
	type CriterionType,
	type SearchResultItem,
	type TargetKind
} from '$lib/search/types';

let _dialogOpen = $state(false);
let _panelOpen = $state(false);
let _target: TargetKind = $state('element');
let _criteria: Criterion[] = $state([]);
let _results: SearchResultItem[] = $state([]);
let _resultsTarget: TargetKind = $state('element');
/** Coverage note (e.g. "searched N of M elements") shown in the results panel. */
let _resultsNote: string | null = $state(null);

export function getSearchDialogOpen(): boolean {
	return _dialogOpen;
}
export function setSearchDialogOpen(open: boolean): void {
	_dialogOpen = open;
}

export function getResultsPanelOpen(): boolean {
	return _panelOpen;
}

export function getSearchTarget(): TargetKind {
	return _target;
}
export function setSearchTarget(target: TargetKind): void {
	if (target === _target) return;
	_target = target;
	_criteria = pruneCriteria(_criteria, target);
}

export function getSearchCriteria(): Criterion[] {
	return _criteria;
}
export function addSearchCriterion(type: CriterionType): void {
	_criteria = [..._criteria, newCriterion(type)];
}
export function updateSearchCriterion(index: number, next: Criterion): void {
	_criteria = _criteria.map((c, i) => (i === index ? next : c));
}
export function removeSearchCriterion(index: number): void {
	_criteria = _criteria.filter((_, i) => i !== index);
}
export function clearSearchCriteria(): void {
	_criteria = [];
}

/** Criterion types available for the current target. */
export function availableCriterionTypes(): CriterionType[] {
	return criteriaForKind(_target);
}

export function getDraftQuery(): AdvancedQuery {
	return { target: _target, criteria: _criteria };
}

export function getSearchResults(): SearchResultItem[] {
	return _results;
}
export function getSearchResultsTarget(): TargetKind {
	return _resultsTarget;
}

export function getSearchResultsNote(): string | null {
	return _resultsNote;
}

/** Store results and open the bottom panel. */
export function commitSearchResults(
	results: SearchResultItem[],
	target: TargetKind,
	note: string | null = null
): void {
	_results = results;
	_resultsTarget = target;
	_resultsNote = note;
	_panelOpen = true;
}

/** X button: clear results and close the panel. */
export function closeResultsPanel(): void {
	_results = [];
	_resultsNote = null;
	_panelOpen = false;
}
