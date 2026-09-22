import type { Side, Surface } from '$lib/api/engine-route';

export const SURFACES = [
	'elements',
	'search',
	'relationships',
	'tree',
	'summary'
] as const satisfies readonly Surface[];

/** The side each surface takes unless `localStorage['dr.surfaces']` says otherwise. */
export const SURFACE_DEFAULTS: Readonly<Record<Surface, Side>> = Object.freeze({
	elements: 'server',
	search: 'server',
	relationships: 'server',
	tree: 'server',
	summary: 'server'
});

const STORAGE_KEY = 'dr.surfaces';

/**
 * The defaults, overlaid with the JSON object stored under `dr.surfaces`: a
 * known surface set to `engine` or `server` is taken, anything else ignored.
 * No storage, a storage that throws or a text that is not a JSON object give
 * the defaults.
 */
export function readSurfaces(storage?: Pick<Storage, 'getItem'>): Record<Surface, Side> {
	const surfaces: Record<Surface, Side> = { ...SURFACE_DEFAULTS };
	let stored: unknown;
	try {
		const text = (storage ?? globalThis.localStorage).getItem(STORAGE_KEY);
		if (text === null) return surfaces;
		stored = JSON.parse(text);
	} catch {
		return surfaces;
	}
	if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return surfaces;
	const overrides = stored as { [key: string]: unknown };
	for (const surface of SURFACES) {
		if (!Object.hasOwn(overrides, surface)) continue;
		const side = overrides[surface];
		if (side === 'engine' || side === 'server') surfaces[surface] = side;
	}
	return surfaces;
}

export function anyEngineSurface(surfaces: Readonly<Record<Surface, Side>>): boolean {
	return SURFACES.some((surface) => surfaces[surface] === 'engine');
}
