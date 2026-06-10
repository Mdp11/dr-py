import { z } from 'zod';

export const ElementSchema = z.object({
	id: z.string(),
	type_name: z.string(),
	properties: z.record(z.string(), z.unknown()),
	rev: z.number().int()
});
export type Element = z.infer<typeof ElementSchema>;

export const RelationshipSchema = z.object({
	id: z.string(),
	type_name: z.string(),
	source_id: z.string(),
	target_id: z.string(),
	properties: z.record(z.string(), z.unknown()),
	rev: z.number().int()
});
export type Relationship = z.infer<typeof RelationshipSchema>;

export const ModelOutSchema = z.object({
	elements: z.array(ElementSchema),
	relationships: z.array(RelationshipSchema)
});
export type ModelOut = z.infer<typeof ModelOutSchema>;

export const IssueSchema = z.object({
	severity: z.enum(['error', 'warning']),
	message: z.string(),
	target_ids: z.array(z.string())
});
export type Issue = z.infer<typeof IssueSchema>;

export const SnapshotInSchema = z.object({
	elements: z.array(ElementSchema),
	relationships: z.array(RelationshipSchema)
});
export type SnapshotIn = z.infer<typeof SnapshotInSchema>;

export const CreateElementRequestSchema = z.object({
	type: z.string(),
	properties: z.record(z.string(), z.unknown()).optional()
});
export type CreateElementRequest = z.infer<typeof CreateElementRequestSchema>;

export const UpdateElementRequestSchema = z.object({
	properties: z.record(z.string(), z.unknown())
});
export type UpdateElementRequest = z.infer<typeof UpdateElementRequestSchema>;

export const CreateRelationshipRequestSchema = z.object({
	type: z.string(),
	source_id: z.string(),
	target_id: z.string()
});
export type CreateRelationshipRequest = z.infer<typeof CreateRelationshipRequestSchema>;

export const InlineModelSchema = z.object({
	elements: z.array(ElementSchema),
	relationships: z.array(RelationshipSchema)
});
export type InlineModel = z.infer<typeof InlineModelSchema>;

export const ValidateRequestSchema = z.object({
	scope: z.array(z.string()).optional(),
	inline: InlineModelSchema.optional()
});
export type ValidateRequest = z.infer<typeof ValidateRequestSchema>;

export const PropertyDefSchema = z.object({
	name: z.string(),
	datatype: z.string(),
	multiplicity: z.string().default('0..1'),
	min: z.number().nullable().default(null),
	max: z.number().nullable().default(null),
	pattern: z.string().nullable().default(null),
	max_length: z.number().int().nullable().default(null)
});
export type PropertyDef = z.infer<typeof PropertyDefSchema>;

export const ElementTypeSchema = z.object({
	name: z.string(),
	abstract: z.boolean().default(false),
	extends: z.string().nullable().default(null),
	properties: z.array(PropertyDefSchema).default([]),
	key: z.array(z.string()).nullable().default(null)
});
export type ElementType = z.infer<typeof ElementTypeSchema>;

export const MappingSchema = z.object({
	source: z.string(),
	target: z.string()
});
export type Mapping = z.infer<typeof MappingSchema>;

export const RelationshipTypeSchema = z.object({
	name: z.string(),
	abstract: z.boolean().default(false),
	extends: z.string().nullable().default(null),
	containment: z.boolean().default(false),
	// `source`/`target` mirror `mappings[0]` (backend keeps them in sync); they
	// remain the single-pair shorthand the picker reads. `mappings` is the full
	// set of allowed (source, target) endpoint pairs.
	source: z.string(),
	target: z.string(),
	mappings: z.array(MappingSchema).default([]),
	source_multiplicity: z.string().default('0..*'),
	target_multiplicity: z.string().default('0..*'),
	properties: z.array(PropertyDefSchema).default([])
});
export type RelationshipType = z.infer<typeof RelationshipTypeSchema>;

export const MetamodelSchema = z.object({
	enums: z.record(z.string(), z.array(z.string())).default({}),
	elements: z.array(ElementTypeSchema).default([]),
	relationships: z.array(RelationshipTypeSchema).default([])
});
export type Metamodel = z.infer<typeof MetamodelSchema>;

export const ElementListSchema = z.array(ElementSchema);
export const RelationshipListSchema = z.array(RelationshipSchema);
export const IssueListSchema = z.array(IssueSchema);

export interface Folder {
	name: string;
	folders: Folder[];
	elements: string[];
}

export const FolderSchema: z.ZodType<Folder> = z.lazy(() =>
	z.object({
		name: z.string(),
		folders: z.array(FolderSchema).default([]),
		elements: z.array(z.string()).default([])
	})
);

export const ViewSchema = z.object({
	name: z.string(),
	folders: z.array(FolderSchema).default([])
});
export type View = z.infer<typeof ViewSchema>;

export const ViewSnapshotResponseSchema = z.object({
	view: ViewSchema,
	warnings: z.array(IssueSchema).default([])
});
export type ViewSnapshotResponse = z.infer<typeof ViewSnapshotResponseSchema>;

export const ViewStateResponseSchema = z.object({
	view: ViewSchema.nullable().default(null),
	warnings: z.array(IssueSchema).default([])
});
export type ViewStateResponse = z.infer<typeof ViewStateResponseSchema>;

export interface Conflict {
	kind: 'id_exists' | 'missing' | 'before_mismatch';
	entity: 'element' | 'relationship';
	id: string;
	reason: string;
}
