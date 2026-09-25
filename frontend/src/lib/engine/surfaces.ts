import type { Side, Surface } from '$lib/api/engine-route';

/** The model reads: what staging on the engine puts on the engine. */
export const READ_SURFACES = [
	'elements',
	'search',
	'relationships',
	'tree',
	'summary'
] as const satisfies readonly Surface[];

export const SURFACES = [
	...READ_SURFACES,
	'navigation',
	'criteria',
	'issues',
	'tables'
] as const satisfies readonly Surface[];

/** The side each surface takes unless `localStorage['dr.surfaces']` says otherwise. */
export const SURFACE_DEFAULTS: Readonly<Record<Surface, Side>> = Object.freeze({
	elements: 'engine',
	search: 'engine',
	relationships: 'engine',
	tree: 'engine',
	summary: 'engine',
	navigation: 'engine',
	criteria: 'engine',
	issues: 'engine',
	tables: 'engine'
});

/** Where the user's model edits are staged: the replica's working copy, or the store's own buffer. */
export type StagingSide = 'engine' | 'legacy';

export const STAGING_DEFAULT: StagingSide = 'engine';

export type Switches = { surfaces: Record<Surface, Side>; staging: StagingSide };

const STORAGE_KEY = 'dr.surfaces';

/**
 * The defaults, overlaid with the JSON object stored under `dr.surfaces`: a
 * known surface set to `engine` or `server` is taken, `staging` set to
 * `engine` or `legacy` is taken, anything else ignored. Staging on the
 * engine puts every read surface on the engine, whatever the object says of
 * it: a staged edit is visible only in the replica's answers. The server
 * never evaluates staged edits, so `navigation`, `criteria` and `tables`
 * keep their own switches, and so does `issues`, which the server answers
 * for staged edits it is sent. No storage, a storage that throws or a text
 * that is not a JSON object give the defaults.
 */
export function readSwitches(storage?: Pick<Storage, 'getItem'>): Switches {
	const switches: Switches = { surfaces: { ...SURFACE_DEFAULTS }, staging: STAGING_DEFAULT };
	let stored: unknown;
	try {
		const text = (storage ?? globalThis.localStorage).getItem(STORAGE_KEY);
		if (text === null) return switches;
		stored = JSON.parse(text);
	} catch {
		return switches;
	}
	if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return switches;
	const overrides = stored as { [key: string]: unknown };
	for (const surface of SURFACES) {
		if (!Object.hasOwn(overrides, surface)) continue;
		const side = overrides[surface];
		if (side === 'engine' || side === 'server') switches.surfaces[surface] = side;
	}
	if (Object.hasOwn(overrides, 'staging')) {
		const staging = overrides['staging'];
		if (staging === 'engine' || staging === 'legacy') switches.staging = staging;
	}
	if (switches.staging === 'engine') {
		for (const surface of READ_SURFACES) switches.surfaces[surface] = 'engine';
	}
	return switches;
}

/** The surface half of `readSwitches`. */
export function readSurfaces(storage?: Pick<Storage, 'getItem'>): Record<Surface, Side> {
	return readSwitches(storage).surfaces;
}

/**
 * Whether some surface can be answered by the engine. `issues` counts only
 * with staging on the engine: the legacy buffer's edits are not in the
 * replica, so its issues are always the server's.
 */
export function anyEngineSurface({ surfaces, staging }: Readonly<Switches>): boolean {
	return SURFACES.some(
		(surface) => surfaces[surface] === 'engine' && (surface !== 'issues' || staging === 'engine')
	);
}
