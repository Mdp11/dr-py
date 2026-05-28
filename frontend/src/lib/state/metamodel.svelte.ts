// Selected metamodel state.
//
// The backend returns a structured Pydantic Metamodel from
// `GET /metamodels/{name}`; it's parsed and typed via the Zod schema in
// `$lib/api/types.ts`.

import type { Metamodel } from '$lib/api/types';

let _metamodelName: string | null = $state(null);
let _metamodel: Metamodel | null = $state(null);

export function getMetamodelName(): string | null {
	return _metamodelName;
}

export function getMetamodel(): Metamodel | null {
	return _metamodel;
}

export function setMetamodel(name: string, metamodel: Metamodel): void {
	_metamodelName = name;
	_metamodel = metamodel;
}

export function clearMetamodel(): void {
	_metamodelName = null;
	_metamodel = null;
}
