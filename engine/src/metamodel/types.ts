/** One declared property, in the field names the server's metamodel document uses. */
export type PropertyDef = {
	name: string;
	datatype: string;
	multiplicity: string;
	min: number | null;
	max: number | null;
	pattern: string | null;
	max_length: number | null;
};

/** An allowed (source, target) element-type pair of a relationship type. */
export type Mapping = { source: string; target: string };

export type ElementType = {
	name: string;
	abstract: boolean;
	extends: string | null;
	properties: PropertyDef[];
	key: string[] | null;
};

export type RelationshipType = {
	name: string;
	abstract: boolean;
	extends: string | null;
	containment: boolean;
	/** Mirrors of `mappings[0]`; `mappings` is the source of truth. */
	source: string | null;
	target: string | null;
	mappings: Mapping[];
	source_multiplicity: string;
	target_multiplicity: string;
	properties: PropertyDef[];
};

/** The metamodel as `GET /metamodel` serves it: validated and normalized. */
export type MetamodelDoc = {
	enums: { [name: string]: string[] };
	elements: ElementType[];
	relationships: RelationshipType[];
};
