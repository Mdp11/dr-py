// Selected metamodel state.
//
// The backend returns a structured Pydantic Metamodel from
// `GET /metamodels/{name}`. T6 will define a proper Zod schema; for now the
// raw JSON is stashed as `unknown` so downstream tasks can refine it.

let _metamodelName: string | null = $state(null);
let _metamodel: unknown | null = $state(null);

export function getMetamodelName(): string | null {
	return _metamodelName;
}

export function getMetamodel(): unknown | null {
	return _metamodel;
}

export function setMetamodel(name: string, metamodel: unknown): void {
	_metamodelName = name;
	_metamodel = metamodel;
}

export function clearMetamodel(): void {
	_metamodelName = null;
	_metamodel = null;
}
