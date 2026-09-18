import { Metamodel, Model, type MetamodelDoc } from '../../src/index.ts';

const prop = (name: string, datatype = 'string') => ({
	name,
	datatype,
	multiplicity: '0..1',
	min: null,
	max: null,
	pattern: null,
	max_length: null
});

const relationship = (name: string, containment: boolean) => ({
	name,
	abstract: false,
	extends: null,
	containment,
	source: 'Node',
	target: 'Node',
	mappings: [{ source: 'Node', target: 'Node' }],
	source_multiplicity: '0..*',
	target_multiplicity: '0..*',
	properties: []
});

/** One element type, a containment and a plain relationship type between its instances. */
export const NODE_DOC: MetamodelDoc = {
	enums: {},
	elements: [
		{
			name: 'Node',
			abstract: false,
			extends: null,
			properties: [prop('name'), prop('__proto__'), prop('constructor'), prop('peer', 'Node')],
			key: null
		}
	],
	relationships: [relationship('Contains', true), relationship('Refers', false)]
};

export const nodeMetamodel = () => Metamodel.fromJSON(NODE_DOC);

/**
 * `a` contains `b` and refers to `c`; `b` contains `d`. Every id is the
 * entity's own name, and every element is named by it in upper case.
 */
export function family(): Model {
	const model = new Model(nodeMetamodel());
	for (const id of ['a', 'b', 'c', 'd']) {
		model.setProperty(model.createElement('Node', id), 'name', id.toUpperCase());
	}
	model.connect('Contains', 'a', 'b', 'a-b');
	model.connect('Contains', 'b', 'd', 'b-d');
	model.connect('Refers', 'a', 'c', 'a-c');
	return model;
}
