import { describe, expect, it } from 'vitest';
import { MetamodelLayoutSchema } from '../types';

describe('MetamodelLayoutSchema', () => {
	it('parses a server payload and defaults positions', () => {
		expect(MetamodelLayoutSchema.parse({})).toEqual({ positions: {} });
		const p = MetamodelLayoutSchema.parse({ positions: { 'el:Zone': { x: 1, y: 2 } } });
		expect(p.positions['el:Zone']).toEqual({ x: 1, y: 2 });
	});
	it('rejects a non-numeric coordinate', () => {
		expect(() => MetamodelLayoutSchema.parse({ positions: { a: { x: 'no', y: 0 } } })).toThrow();
	});
});
