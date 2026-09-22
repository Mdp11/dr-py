import { describe, expect, it } from 'vitest';
import { SURFACE_DEFAULTS, SURFACES, anyEngineSurface, readSurfaces } from '../surfaces';

/** A storage holding `value` under `dr.surfaces`, and nothing else. */
const storing = (value: string | null) => ({
	getItem: (key: string) => (key === 'dr.surfaces' ? value : null)
});

const allServer = {
	elements: 'server',
	search: 'server',
	relationships: 'server',
	tree: 'server',
	summary: 'server'
} as const;

describe('the surface switches', () => {
	it('names the five read surfaces, every one on the server by default', () => {
		expect(SURFACES).toEqual(['elements', 'search', 'relationships', 'tree', 'summary']);
		expect(SURFACE_DEFAULTS).toEqual(allServer);
		expect(readSurfaces(storing(null))).toEqual(allServer);
	});

	it('an override moves the one surface it names', () => {
		expect(readSurfaces(storing('{"search": "engine"}'))).toEqual({
			...allServer,
			search: 'engine'
		});
		expect(readSurfaces(storing('{"search": "engine", "tree": "server"}'))).toEqual({
			...allServer,
			search: 'engine'
		});
	});

	it('an unknown surface is ignored', () => {
		expect(readSurfaces(storing('{"staging": "engine"}'))).toEqual(allServer);
		expect(readSurfaces(storing('{"toString": "engine"}'))).toEqual(allServer);
	});

	it('a value other than engine or server is ignored', () => {
		expect(readSurfaces(storing('{"tree": "Engine", "summary": true}'))).toEqual(allServer);
	});

	it('bad JSON, or JSON that is not an object, gives the defaults', () => {
		expect(readSurfaces(storing('{tree: engine'))).toEqual(allServer);
		expect(readSurfaces(storing('["engine"]'))).toEqual(allServer);
		expect(readSurfaces(storing('"engine"'))).toEqual(allServer);
		expect(readSurfaces(storing('null'))).toEqual(allServer);
	});

	it('a storage that throws gives the defaults', () => {
		const throwing = {
			getItem: (): string | null => {
				throw new DOMException('denied', 'SecurityError');
			}
		};
		expect(readSurfaces(throwing)).toEqual(allServer);
	});

	it('reads localStorage when handed no storage', () => {
		localStorage.setItem('dr.surfaces', '{"elements": "engine"}');
		try {
			expect(readSurfaces()).toEqual({ ...allServer, elements: 'engine' });
		} finally {
			localStorage.removeItem('dr.surfaces');
		}
	});

	it('returns a fresh record each time', () => {
		const surfaces = readSurfaces(storing(null));
		surfaces.tree = 'engine';
		expect(SURFACE_DEFAULTS.tree).toBe('server');
		expect(readSurfaces(storing(null)).tree).toBe('server');
	});

	it('anyEngineSurface says whether one surface is on the engine', () => {
		expect(anyEngineSurface(allServer)).toBe(false);
		expect(anyEngineSurface({ ...allServer, summary: 'engine' })).toBe(true);
	});
});
