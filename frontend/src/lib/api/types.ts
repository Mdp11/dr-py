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
	target_ids: z.array(z.string()),
	origin: z.enum(['on_server', 'uncommitted', 'resolved']).default('on_server')
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

export const RelationshipListSchema = z.array(RelationshipSchema);
export const IssueListSchema = z.array(IssueSchema);

export interface ArtifactRef {
	id: string;
	kind: string;
}

export interface Folder {
	name: string;
	folders: Folder[];
	elements: string[];
	artifacts: ArtifactRef[];
}

export const FolderSchema: z.ZodType<Folder> = z.lazy(() =>
	z.object({
		name: z.string(),
		folders: z.array(FolderSchema).default([]),
		elements: z.array(z.string()).default([]),
		artifacts: z.array(z.object({ id: z.string(), kind: z.string() })).default([])
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

// ---------------------------------------------------------------------------
// Delta-protocol schemas (Phase D1) — mirror the backend pydantic models in
// src/data_rover/api/schemas.py (OpsResponse, ModelSummary, the paged read
// shapes, and the streaming load/save responses).
// ---------------------------------------------------------------------------

export const IssueCountsSchema = z.record(z.string(), z.number().int());
export type IssueCounts = z.infer<typeof IssueCountsSchema>;

/**
 * Response of POST /model/ops, /model/undo, and session-mode /model/apply-cr.
 * A delta over the session model: created/updated entities in their final
 * post-batch state, deleted ids (including containment cascades), the temp-id
 * resolution map, and the validation-issue splice the batch produced.
 */
export const OpsResponseSchema = z.object({
	model_rev: z.number().int(),
	id_map: z.record(z.string(), z.string()).default({}),
	changed_elements: z.array(ElementSchema).default([]),
	changed_relationships: z.array(RelationshipSchema).default([]),
	deleted_element_ids: z.array(z.string()).default([]),
	deleted_relationship_ids: z.array(z.string()).default([]),
	issues_removed_owner_ids: z.array(z.string()).default([]),
	issues_added: z.array(IssueSchema).default([]),
	issue_counts: IssueCountsSchema.default({})
});
export type OpsResponse = z.infer<typeof OpsResponseSchema>;

// --- Phase 4 check-out / commit (Spec B) -----------------------------------

export const LockTargetInSchema = z.object({
	resource_id: z.string(),
	mode: z.enum(['exclusive', 'shared'])
});
export type LockTargetIn = z.infer<typeof LockTargetInSchema>;

export const LockIntentSchema = z.enum(['edit', 'create_child', 'connect', 'delete']);
export type LockIntent = z.infer<typeof LockIntentSchema>;

export const LockRequestSchema = z.object({
	targets: z.array(LockTargetInSchema),
	intent: LockIntentSchema,
	steal: z.boolean().default(false)
});
export type LockRequest = z.infer<typeof LockRequestSchema>;

export const LeaseOutSchema = z.object({
	resource_id: z.string(),
	mode: z.string(),
	holder: z.string(),
	holder_email: z.string().optional(),
	token: z.string(),
	intent: z.string(),
	expires_at: z.number()
});
export type LeaseOut = z.infer<typeof LeaseOutSchema>;

export const LockResponseSchema = z.object({
	token: z.string(),
	leases: z.array(LeaseOutSchema).default([])
});
export type LockResponse = z.infer<typeof LockResponseSchema>;

export const RenewResponseSchema = z.object({ ok: z.boolean() });
export type RenewResponse = z.infer<typeof RenewResponseSchema>;

export const OpenResponseSchema = z.object({
	model_rev: z.number().int(),
	role: z.string(),
	element_count: z.number().int(),
	relationship_count: z.number().int(),
	issue_counts: z.record(z.string(), z.number()).default({}),
	lock_ttl_seconds: z.number().int().default(0),
	strict_mode: z.boolean().default(false)
});
export type OpenResponse = z.infer<typeof OpenResponseSchema>;

export const IssueOutSchema = z.object({
	severity: z.string(),
	message: z.string(),
	target_ids: z.array(z.string()).default([]),
	category: z.string().default('conformance')
});
export type IssueOut = z.infer<typeof IssueOutSchema>;

export const MetamodelDiffSchema = z.object({
	now_failing: z.array(IssueOutSchema).default([]),
	now_passing: z.array(IssueOutSchema).default([]),
	unchanged_count: z.number().int(),
	current_error_count: z.number().int(),
	candidate_error_count: z.number().int()
});
export type MetamodelDiff = z.infer<typeof MetamodelDiffSchema>;

export const RebindSchema = z.object({
	model_rev: z.number().int(),
	metamodel_id: z.string(),
	validation_error_count: z.number().int(),
	issue_counts: z.record(z.string(), z.number()).default({}),
	issues: z.array(IssueOutSchema).default([])
});
export type Rebind = z.infer<typeof RebindSchema>;

export const PreviewResponseSchema = z.object({
	conformance_error_count: z.number().int(),
	structural_blockers: z.array(IssueOutSchema).default([]),
	issues: z.array(IssueOutSchema).default([]),
	would_block: z.boolean().default(false)
});
export type PreviewResponse = z.infer<typeof PreviewResponseSchema>;

export const CommitResponseSchema = OpsResponseSchema.extend({
	commit_id: z.string(),
	message: z.string().default(''),
	validation_error_count: z.number().int().default(0)
});
export type CommitResponse = z.infer<typeof CommitResponseSchema>;

/**
 * GET /model/summary. `issue_counts` is null until a full validation run has
 * seeded the session issue store — "not validated" is distinct from "0".
 */
export const ModelSummarySchema = z.object({
	model_rev: z.number().int(),
	element_count: z.number().int(),
	relationship_count: z.number().int(),
	elements_by_type: z.record(z.string(), z.number().int()).default({}),
	issue_counts: IssueCountsSchema.nullable().default(null),
	undo_depth: z.number().int().default(0)
});
export type ModelSummary = z.infer<typeof ModelSummarySchema>;

export const ElementPageSchema = z.object({
	items: z.array(ElementSchema).default([]),
	total: z.number().int().default(0)
});
export type ElementPage = z.infer<typeof ElementPageSchema>;

export const ElementListSchema = z.object({
	items: z.array(ElementSchema).default([])
});
export type ElementList = z.infer<typeof ElementListSchema>;

export const NeighborhoodSchema = z.object({
	nodes: z.array(ElementSchema).default([]),
	edges: z.array(RelationshipSchema).default([]),
	hops_by_id: z.record(z.string(), z.number().int()).default({}),
	truncated: z.boolean().default(false)
});
export type Neighborhood = z.infer<typeof NeighborhoodSchema>;

export const RelationshipPageSchema = z.object({
	items: z.array(RelationshipSchema).default([]),
	total: z.number().int().default(0)
});
export type RelationshipPage = z.infer<typeof RelationshipPageSchema>;

// POST /model/search — exactly one of elements/relationships is populated,
// selected by `target`; `total` is the match count before limit/offset paging.
export const SearchResultPageSchema = z.object({
	target: z.enum(['element', 'relationship']),
	elements: z.array(ElementSchema).default([]),
	relationships: z.array(RelationshipSchema).default([]),
	total: z.number().int().default(0)
});
export type SearchResultPage = z.infer<typeof SearchResultPageSchema>;

export const TreeItemSchema = z.object({
	id: z.string(),
	type_name: z.string(),
	display_name: z.string(),
	child_count: z.number().default(0)
});
export type TreeItem = z.infer<typeof TreeItemSchema>;

export const TreeItemPageSchema = z.object({
	items: z.array(TreeItemSchema).default([]),
	total: z.number().default(0)
});
export type TreeItemPage = z.infer<typeof TreeItemPageSchema>;

// ---------------------------------------------------------------------------
// Project artifacts (Stage 1: saved navigations; tables/diagrams later)
// ---------------------------------------------------------------------------

export const ArtifactHeaderSchema = z.object({
	id: z.string(),
	kind: z.string(),
	name: z.string(),
	artifact_rev: z.number().int(),
	updated_at: z.string(),
	updated_by: z.string().nullable().default(null)
});
export type ArtifactHeader = z.infer<typeof ArtifactHeaderSchema>;

export const ArtifactListSchema = z.object({
	items: z.array(ArtifactHeaderSchema).default([])
});
export type ArtifactList = z.infer<typeof ArtifactListSchema>;

// Navigation definition — mirrors core/navigation/schema.py. Criteria reuse
// the advanced-search criterion wire shape (lib/search/types.ts Criterion).
export type NavDirection = 'out' | 'in' | 'either';

export interface NavScope {
	kind: 'scope';
	types: string[];
	criteria: unknown[]; // search Criterion objects; typed at the editor layer
}

export interface NavStep {
	relationship_type: string;
	direction: NavDirection;
	target: NavScope;
	children: NavStep[];
}

export interface PathNavigation {
	kind: 'path';
	schema_version: number;
	start: NavScope | SetExpression;
	steps: NavStep[];
}

export interface NavOperand {
	ref?: string | null;
	definition?: NavigationDefinition | null;
	step_index?: number | null;
}

export interface SetExpression {
	kind: 'set_op';
	schema_version: number;
	op: 'union' | 'intersection' | 'difference' | 'symmetric_difference';
	operands: NavOperand[];
}

export type NavigationDefinition = PathNavigation | SetExpression;

// The schema only guards transport shape (the editor constructs/consumes
// NavigationDefinition values directly); `start`/nested definitions are typed
// loosely here rather than fighting zod's recursive-union inference, while the
// exported TS interfaces above stay strict for app code.
export const NavigationDefinitionSchema: z.ZodType<NavigationDefinition> = z.lazy(() =>
	z.union([
		z.object({
			kind: z.literal('path'),
			schema_version: z.number().int().default(1),
			start: z.unknown(),
			steps: z.array(z.unknown()).default([])
		}),
		z.object({
			kind: z.literal('set_op'),
			schema_version: z.number().int().default(1),
			op: z.enum(['union', 'intersection', 'difference', 'symmetric_difference']),
			operands: z.array(z.unknown()).default([])
		})
	])
) as z.ZodType<NavigationDefinition>;

export const ArtifactSchema = ArtifactHeaderSchema.extend({
	payload: z.record(z.string(), z.unknown()).default({})
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const ChainPageSchema = z.object({
	step_types: z.array(z.string()).default([]),
	chains: z.array(z.array(TreeItemSchema)).default([]),
	total: z.number().int().default(0),
	truncated: z.boolean().default(false)
});
export type ChainPage = z.infer<typeof ChainPageSchema>;

const ModifiedElementSchema = z.object({
	id: z.string(),
	before: ElementSchema,
	after: ElementSchema
});

const ModifiedRelationshipSchema = z.object({
	id: z.string(),
	before: RelationshipSchema,
	after: RelationshipSchema
});

/**
 * GET /model/changes: the session op log compacted into a `datarover.cr/v1`
 * change request (the shape `buildChangeRequest` in `$lib/state/cr.ts`
 * produces) plus `complete` — false when op-log truncation means the document
 * only describes the retained history.
 */
export const ChangesDocSchema = z.object({
	format: z.literal('datarover.cr/v1'),
	createdAt: z.string(),
	baseline: z.object({
		filename: z.string().nullable().default(null),
		elementCount: z.number().int().default(0),
		relationshipCount: z.number().int().default(0)
	}),
	ops: z.object({
		elements: z.object({
			added: z.array(ElementSchema).default([]),
			modified: z.array(ModifiedElementSchema).default([]),
			deleted: z.array(ElementSchema).default([])
		}),
		relationships: z.object({
			added: z.array(RelationshipSchema).default([]),
			modified: z.array(ModifiedRelationshipSchema).default([]),
			deleted: z.array(RelationshipSchema).default([])
		})
	}),
	complete: z.boolean().default(true)
});
export type ChangesDoc = z.infer<typeof ChangesDocSchema>;

export const ChangesSummarySchema = z.object({
	batches: z.number().int().default(0),
	ops: z.number().int().default(0),
	adds: z.number().int().default(0),
	modifies: z.number().int().default(0),
	deletes: z.number().int().default(0),
	complete: z.boolean().default(true)
});
export type ChangesSummary = z.infer<typeof ChangesSummarySchema>;

export const SaveModelResponseSchema = z.object({
	path: z.string(),
	element_count: z.number().int(),
	relationship_count: z.number().int(),
	bytes_written: z.number().int()
});
export type SaveModelResponse = z.infer<typeof SaveModelResponseSchema>;

export const CommitSummarySchema = z.object({
	rev: z.number(),
	commit_id: z.string(),
	author_id: z.string().nullable(),
	ts: z.string(),
	message: z.string(),
	validation_error_count: z.number(),
	op_count: z.number(),
	is_rebind: z.boolean()
});
export type CommitSummary = z.infer<typeof CommitSummarySchema>;

export const CommitHistoryResponseSchema = z.object({
	commits: z.array(CommitSummarySchema),
	has_more: z.boolean()
});
export type CommitHistoryResponse = z.infer<typeof CommitHistoryResponseSchema>;

export const ProjectSettingsSchema = z.object({
	strict_mode: z.boolean()
});
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;
