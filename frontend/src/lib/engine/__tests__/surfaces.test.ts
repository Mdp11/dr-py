import { describe, expect, it } from 'vitest';
import { SURFACE_DEFAULTS, SURFACES, anyEngineSurface, readSurfaces } from '../surfaces';

/** A storage holding `value` under `dr.surfaces`, and nothing else. */
const storing = (value: string | null) => ({
	getItem: (key: string) => (key === 'dr.surfaces' ? value : null)
});

describe('the surface switches', () => {
	it('names the five read surfaces, and reads the defaults with no override', () => {
		expect(SURFACES).toEqual(['elements', 'search', 'relationships', 'tree', 'summary']);
		expect(readSurfaces(storing(null))).toEqual(SURFACE_DEFAULTS);
	});

	it('an override moves the one surface it names', () => {
		expect(readSurfaces(storing('{"search": "engine"}'))).toEqual({
			...SURFACE_DEFAULTS,
			search: 'engine'
		});
		expect(readSurfaces(storing('{"search": "engine", "tree": "server"}'))).toEqual({
			...SURFACE_DEFAULTS,
			search: 'engine',
			tree: 'server'
		});
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
		localStorage.setItem('dr.surfaces', '{"elements": "engine"}');
		try {
			expect(readSurfaces()).toEqual({ ...SURFACE_DEFAULTS, elements: 'engine' });
		} finally {
			localStorage.removeItem('dr.surfaces');
		}
	});

	it('returns a fresh record each time, independent of SURFACE_DEFAULTS', () => {
		const surfaces = readSurfaces(storing(null));
		const original = SURFACE_DEFAULTS.tree;
		surfaces.tree = original === 'server' ? 'engine' : 'server';
		expect(SURFACE_DEFAULTS.tree).toBe(original);
		expect(readSurfaces(storing(null)).tree).toBe(original);
	});

	it('anyEngineSurface says whether one surface is on the engine', () => {
		const allServer = {
			elements: 'server',
			search: 'server',
			relationships: 'server',
			tree: 'server',
			summary: 'server'
		} as const;
		expect(anyEngineSurface(allServer)).toBe(false);
		expect(anyEngineSurface({ ...allServer, summary: 'engine' })).toBe(true);
	});
});
