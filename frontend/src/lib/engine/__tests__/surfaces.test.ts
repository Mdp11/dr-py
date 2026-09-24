import { describe, expect, it } from 'vitest';
import {
	READ_SURFACES,
	STAGING_DEFAULT,
	SURFACE_DEFAULTS,
	SURFACES,
	anyEngineSurface,
	readSurfaces,
	readSwitches
} from '../surfaces';

/** A storage holding `value` under `dr.surfaces`, and nothing else. */
const storing = (value: string | null) => ({
	getItem: (key: string) => (key === 'dr.surfaces' ? value : null)
});

describe('the surface switches', () => {
	it('names the five read surfaces, the two evaluations and the issues, all eight on the engine by default', () => {
		expect(READ_SURFACES).toEqual(['elements', 'search', 'relationships', 'tree', 'summary']);
		expect(SURFACES).toEqual([...READ_SURFACES, 'navigation', 'criteria', 'issues']);
		expect(SURFACE_DEFAULTS).toEqual({
			elements: 'engine',
			search: 'engine',
			relationships: 'engine',
			tree: 'engine',
			summary: 'engine',
			navigation: 'engine',
			criteria: 'engine',
			issues: 'engine'
		});
		expect(readSurfaces(storing(null))).toEqual(SURFACE_DEFAULTS);
	});

	it('dr.surfaces sets navigation and criteria, each on its own, whatever staging says', () => {
		for (const staging of ['engine', 'legacy']) {
			expect(
				readSurfaces(storing(`{"staging": "${staging}", "navigation": "server"}`))
			).toMatchObject({ navigation: 'server', criteria: 'engine' });
			expect(
				readSurfaces(storing(`{"staging": "${staging}", "criteria": "server"}`))
			).toMatchObject({ navigation: 'engine', criteria: 'server' });
		}
		expect(readSurfaces(storing('{"navigation": "server", "criteria": "server"}'))).toEqual({
			...SURFACE_DEFAULTS,
			navigation: 'server',
			criteria: 'server'
		});
	});

	it('issues default to the engine, staging on the engine does not force them off, and dr.surfaces moves them', () => {
		expect(readSwitches(storing('{"staging": "engine"}'))).toEqual({
			surfaces: SURFACE_DEFAULTS,
			staging: 'engine'
		});
		for (const staging of ['engine', 'legacy']) {
			expect(readSurfaces(storing(`{"staging": "${staging}", "issues": "engine"}`)).issues).toBe(
				'engine'
			);
		}
		expect(readSurfaces(storing('{"staging": "engine", "issues": "server"}')).issues).toBe(
			'server'
		);
	});

	it('an override moves the one surface it names', () => {
		// staging defaults to 'engine', which forces every surface back to it,
		// so a surface-only override needs staging pinned to 'legacy' to
		// actually take effect.
		expect(readSurfaces(storing('{"staging": "legacy", "search": "server"}'))).toEqual({
			...SURFACE_DEFAULTS,
			search: 'server'
		});
		expect(
			readSurfaces(storing('{"staging": "legacy", "search": "engine", "tree": "server"}'))
		).toEqual({
			...SURFACE_DEFAULTS,
			search: 'engine',
			tree: 'server'
		});
	});

	it('a surface-only override with no staging key comes back all-engine', () => {
		// staging is 'engine' by default with nothing to override it, which
		// forces every surface back to it whatever this object says of them.
		expect(readSurfaces(storing('{"search": "server"}'))).toEqual(SURFACE_DEFAULTS);
	});

	it('an unknown surface is ignored', () => {
		expect(readSurfaces(storing('{"staging": "engine"}'))).toEqual(SURFACE_DEFAULTS);
		expect(readSurfaces(storing('{"toString": "engine"}'))).toEqual(SURFACE_DEFAULTS);
	});

	it('a value other than engine or server is ignored', () => {
		expect(readSurfaces(storing('{"tree": "Engine", "summary": true}'))).toEqual(SURFACE_DEFAULTS);
	});

	it('bad JSON, or JSON that is not an object, gives the defaults', () => {
		expect(readSurfaces(storing('{tree: engine'))).toEqual(SURFACE_DEFAULTS);
		expect(readSurfaces(storing('["engine"]'))).toEqual(SURFACE_DEFAULTS);
		expect(readSurfaces(storing('"engine"'))).toEqual(SURFACE_DEFAULTS);
		expect(readSurfaces(storing('null'))).toEqual(SURFACE_DEFAULTS);
	});

	it('a storage that throws gives the defaults', () => {
		const throwing = {
			getItem: (): string | null => {
				throw new DOMException('denied', 'SecurityError');
			}
		};
		expect(readSurfaces(throwing)).toEqual(SURFACE_DEFAULTS);
	});

	it('reads localStorage when handed no storage', () => {
		localStorage.setItem('dr.surfaces', '{"staging": "legacy", "elements": "server"}');
		try {
			expect(readSurfaces()).toEqual({ ...SURFACE_DEFAULTS, elements: 'server' });
		} finally {
			localStorage.removeItem('dr.surfaces');
		}
	});

	it('returns a fresh record each time, independent of SURFACE_DEFAULTS', () => {
		const surfaces = readSurfaces(storing(null));
		surfaces.tree = 'server';
		expect(SURFACE_DEFAULTS.tree).toBe('engine');
		expect(readSurfaces(storing(null)).tree).toBe('engine');
	});

	it('readSwitches gives the staging default beside the surface defaults', () => {
		expect(STAGING_DEFAULT).toBe('engine');
		expect(readSwitches(storing(null))).toEqual({
			surfaces: SURFACE_DEFAULTS,
			staging: STAGING_DEFAULT
		});
		expect(readSwitches()).toEqual({ surfaces: SURFACE_DEFAULTS, staging: STAGING_DEFAULT });
		localStorage.setItem('dr.surfaces', '{"staging": "legacy"}');
		try {
			expect(readSwitches().staging).toBe('legacy');
		} finally {
			localStorage.removeItem('dr.surfaces');
		}
	});

	it('staging on the engine puts every read surface on the engine and leaves the two evaluations alone', () => {
		expect(readSwitches(storing('{"staging": "engine", "tree": "server"}'))).toEqual({
			surfaces: SURFACE_DEFAULTS,
			staging: 'engine'
		});
		const allServer =
			'{"staging": "engine", "elements": "server", "search": "server", ' +
			'"relationships": "server", "tree": "server", "summary": "server", ' +
			'"navigation": "server", "criteria": "server"}';
		expect(readSwitches(storing(allServer)).surfaces).toEqual({
			...SURFACE_DEFAULTS,
			navigation: 'server',
			criteria: 'server'
		});
		const surfaces = readSwitches(
			storing('{"staging": "engine", "navigation": "server", "criteria": "server"}')
		).surfaces;
		for (const surface of READ_SURFACES) expect(surfaces[surface]).toBe('engine');
		expect(surfaces).toMatchObject({ navigation: 'server', criteria: 'server' });
	});

	it('legacy staging leaves the surfaces as they are set', () => {
		expect(readSwitches(storing('{"staging": "legacy", "tree": "server"}'))).toEqual({
			surfaces: { ...SURFACE_DEFAULTS, tree: 'server' },
			staging: 'legacy'
		});
	});

	it('a staging value other than engine or legacy is the default', () => {
		expect(readSwitches(storing('{"staging": "other"}'))).toEqual({
			surfaces: SURFACE_DEFAULTS,
			staging: STAGING_DEFAULT
		});
		// the default is 'engine', which forces every surface to it too, so an
		// invalid staging value alongside a surface override loses the override.
		expect(readSwitches(storing('{"staging": "server", "tree": "server"}'))).toEqual({
			surfaces: SURFACE_DEFAULTS,
			staging: STAGING_DEFAULT
		});
	});

	it('bad JSON, or a storage that throws, gives every default', () => {
		const defaults = { surfaces: SURFACE_DEFAULTS, staging: STAGING_DEFAULT };
		expect(readSwitches(storing('{staging: engine'))).toEqual(defaults);
		expect(readSwitches(storing('["engine"]'))).toEqual(defaults);
		const throwing = {
			getItem: (): string | null => {
				throw new DOMException('denied', 'SecurityError');
			}
		};
		expect(readSwitches(throwing)).toEqual(defaults);
	});

	it('readSurfaces is the surfaces half of readSwitches', () => {
		for (const text of [
			null,
			'{"tree": "server"}',
			'{"staging": "engine", "tree": "server"}',
			'{"staging": "legacy", "summary": "server"}',
			'{"staging": "other", "search": "server"}',
			'not json'
		]) {
			expect(readSurfaces(storing(text))).toEqual(readSwitches(storing(text)).surfaces);
		}
	});

	it('anyEngineSurface says whether one surface is on the engine', () => {
		const allServer = {
			elements: 'server',
			search: 'server',
			relationships: 'server',
			tree: 'server',
			summary: 'server',
			navigation: 'server',
			criteria: 'server',
			issues: 'server'
		} as const;
		expect(anyEngineSurface(allServer)).toBe(false);
		expect(anyEngineSurface({ ...allServer, issues: 'engine' })).toBe(true);
		expect(anyEngineSurface({ ...allServer, summary: 'engine' })).toBe(true);
		expect(anyEngineSurface({ ...allServer, navigation: 'engine' })).toBe(true);
		expect(anyEngineSurface({ ...allServer, criteria: 'engine' })).toBe(true);
	});
});
