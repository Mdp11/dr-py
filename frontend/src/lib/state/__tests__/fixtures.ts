/** Inert entity fixtures shared by the staging suites. Data only — each suite
 * keeps its own beforeEach/afterEach so their lifecycles stay independent. */

export const EL = { id: 'e1', type_name: 'Building', properties: { name: 'Town Hall' }, rev: 1 };

export const EL2 = { id: 'e2', type_name: 'District', properties: {}, rev: 1 };

export const REL = {
	id: 'r1',
	type_name: 'Owns',
	source_id: 'e1',
	target_id: 'e2',
	properties: {},
	rev: 1
};
