// Active metamodel state. The backend holds a single metamodel session;
// this mirrors it on the client for derived UI state.

import type { Metamodel } from '$lib/api/types';

let _metamodel: Metamodel | null = $state(null);

export function getMetamodel(): Metamodel | null {
	return _metamodel;
}

export function setMetamodel(metamodel: Metamodel): void {
	_metamodel = metamodel;
}

export function clearMetamodel(): void {
	_metamodel = null;
}
