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
	name: z.string(),
	metamodel: z.string(),
	rev: z.number().int(),
	elements: z.array(ElementSchema),
	relationships: z.array(RelationshipSchema)
});
export type ModelOut = z.infer<typeof ModelOutSchema>;

export const ModelRefSchema = z.object({
	name: z.string(),
	metamodel: z.string()
});
export type ModelRef = z.infer<typeof ModelRefSchema>;

export const IssueSchema = z.object({
	severity: z.enum(['error', 'warning']),
	message: z.string(),
	target_ids: z.array(z.string())
});
export type Issue = z.infer<typeof IssueSchema>;

export const SnapshotInSchema = z.object({
	rev: z.number().int(),
	elements: z.array(ElementSchema),
	relationships: z.array(RelationshipSchema)
});
export type SnapshotIn = z.infer<typeof SnapshotInSchema>;

export const SnapshotOutSchema = z.object({
	rev: z.number().int()
});
export type SnapshotOut = z.infer<typeof SnapshotOutSchema>;

export const CreateModelRequestSchema = z.object({
	name: z.string(),
	metamodel: z.string()
});
export type CreateModelRequest = z.infer<typeof CreateModelRequestSchema>;

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

export const MetamodelNameListSchema = z.array(z.string());
export const ModelRefListSchema = z.array(ModelRefSchema);
export const ElementListSchema = z.array(ElementSchema);
export const RelationshipListSchema = z.array(RelationshipSchema);
export const IssueListSchema = z.array(IssueSchema);
