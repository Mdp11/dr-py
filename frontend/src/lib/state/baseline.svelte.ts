import type { ModelOut } from '$lib/api/types';

let _baseline: ModelOut | null = $state(null);

export function getBaseline(): ModelOut | null {
	return _baseline;
}

export function setBaseline(model: ModelOut | null): void {
	_baseline = model;
}
