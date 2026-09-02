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
	check: z.string().default(''),
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

// --- structural metamodel diff ----------------------------------------------
export const FieldChangeSchema = z.object({
	field: z.string(),
	from: z.unknown(),
	to: z.unknown()
});
export type FieldChange = z.infer<typeof FieldChangeSchema>;

const EnumEntrySchema = z.object({ name: z.string(), literals: z.array(z.string()).default([]) });
const EnumChangeSchema = z.object({
	name: z.string(),
	added: z.array(z.string()).default([]),
	removed: z.array(z.string()).default([])
});
const EnumsDiffSchema = z.object({
	added: z.array(EnumEntrySchema).default([]),
	removed: z.array(EnumEntrySchema).default([]),
	changed: z.array(EnumChangeSchema).default([])
});

const PropertyChangeSchema = z.object({
	name: z.string(),
	fields: z.array(FieldChangeSchema).default([])
});
const PropertiesDiffSchema = z.object({
	added: z.array(PropertyDefSchema).default([]),
	removed: z.array(PropertyDefSchema).default([]),
	changed: z.array(PropertyChangeSchema).default([])
});

const ElementTypeChangeSchema = z.object({
	name: z.string(),
	attributes: z.array(FieldChangeSchema).default([]),
	properties: PropertiesDiffSchema
});
const ElementTypesDiffSchema = z.object({
	added: z.array(ElementTypeSchema).default([]),
	removed: z.array(ElementTypeSchema).default([]),
	changed: z.array(ElementTypeChangeSchema).default([])
});

// An added/removed ABSTRACT relationship type can have null source/target
// (the shorthand mirrors mappings[0], which may not exist), so the diff
// entries relax RelationshipTypeSchema's non-null endpoints.
const RelationshipTypeDiffEntrySchema = RelationshipTypeSchema.extend({
	source: z.string().nullable().default(null),
	target: z.string().nullable().default(null)
});
const MappingsDiffSchema = z.object({
	added: z.array(MappingSchema).default([]),
	removed: z.array(MappingSchema).default([])
});
const RelationshipTypeChangeSchema = z.object({
	name: z.string(),
	attributes: z.array(FieldChangeSchema).default([]),
	properties: PropertiesDiffSchema,
	mappings: MappingsDiffSchema
});
const RelationshipTypesDiffSchema = z.object({
	added: z.array(RelationshipTypeDiffEntrySchema).default([]),
	removed: z.array(RelationshipTypeDiffEntrySchema).default([]),
	changed: z.array(RelationshipTypeChangeSchema).default([])
});

export const MetamodelStructuralDiffSchema = z.object({
	enums: EnumsDiffSchema,
	element_types: ElementTypesDiffSchema,
	relationship_types: RelationshipTypesDiffSchema
});
export type MetamodelStructuralDiff = z.infer<typeof MetamodelStructuralDiffSchema>;

export const RelationshipListSchema = z.array(RelationshipSchema);
export const IssueListSchema = z.array(IssueSchema);

export interface ArtifactRef {
	id: string;
	kind: string;
}

export interface Folder {
	/** Stable uuid4-hex id, healed server-side on every read. Locally
	 * staged folders carry a `tmp_` id until their commit's id_map lands. */
	id: string;
	name: string;
	folders: Folder[];
	elements: string[];
	artifacts: ArtifactRef[];
}

export const FolderSchema: z.ZodType<Folder> = z.lazy(() =>
	z.object({
		id: z.string(),
		name: z.string(),
		folders: z.array(FolderSchema).default([]),
		elements: z.array(z.string()).default([]),
		artifacts: z.array(z.object({ id: z.string(), kind: z.string() })).default([])
	})
);

export const ViewSchema = z.object({
	name: z.string(),
	folders: z.array(FolderSchema).default([]),
	// Same shape as `FolderSchema.artifacts` — an artifact ref may sit directly
	// at the view root, alongside top-level folders.
	artifacts: z.array(z.object({ id: z.string(), kind: z.string() })).default([])
});
export type View = z.infer<typeof ViewSchema>;

export const ViewStateResponseSchema = z.object({
	view: ViewSchema.nullable().default(null),
	warnings: z.array(IssueSchema).default([]),
	// informational only — no view op carries a `view_rev` precondition (the
	// folder:/view: lease is the concurrency control)
	view_rev: z.number().int().nullable().default(null)
});
export type ViewStateResponse = z.infer<typeof ViewStateResponseSchema>;

/** One row of `GET /views` — a project's named views; content is fetched per
 * view through `GET /views/{id}`. */
export const ViewSummarySchema = z.object({
	id: z.string(),
	name: z.string(),
	view_rev: z.number().int().default(0)
});
export type ViewSummary = z.infer<typeof ViewSummarySchema>;

export const ConflictSchema = z.object({
	kind: z.enum(['id_exists', 'missing', 'before_mismatch']),
	entity: z.enum(['element', 'relationship']),
	id: z.string(),
	reason: z.string()
});
export type Conflict = z.infer<typeof ConflictSchema>;

// ---------------------------------------------------------------------------
// Delta-protocol schemas — mirror the backend pydantic models in
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

// ArtifactHeaderSchema sits here rather than in the "Project artifacts"
// section below because CommitResponseSchema, just below, references it — a
// `const` referenced before its module-init assignment throws (TDZ), so
// definition order in this file must follow use.
export const ArtifactHeaderSchema = z.object({
	id: z.string(),
	kind: z.string(),
	name: z.string(),
	artifact_rev: z.number().int(),
	updated_at: z.string(),
	updated_by: z.string().nullable().default(null),
	entry_points: z.array(z.string()).nullable().optional().default(null)
});
export type ArtifactHeader = z.infer<typeof ArtifactHeaderSchema>;

// --- check-out / commit -----------------------------------------------------

export const LockTargetInSchema = z.object({
	resource_id: z.string(),
	mode: z.enum(['exclusive', 'shared']),
	// what the id names; the backend canonicalizes ("artifact" -> "art:<id>",
	// "metamodel" -> "mm", "folder" -> "folder:<id>", "view" -> "view:<id>" —
	// the root-membership lease of a view). Optional: absent means "element",
	// so every pre-existing element call site is untouched.
	type: z.enum(['element', 'artifact', 'metamodel', 'folder', 'view']).optional()
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
	category: z.string().default('conformance'),
	origin: z.string().default('on_server')
});
export type IssueOut = z.infer<typeof IssueOutSchema>;

export const MetamodelDiffSchema = z.object({
	now_failing: z.array(IssueOutSchema).default([]),
	now_passing: z.array(IssueOutSchema).default([]),
	unchanged_count: z.number().int(),
	current_error_count: z.number().int(),
	candidate_error_count: z.number().int(),
	structural: MetamodelStructuralDiffSchema
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

export const RawMetamodelSchema = z.object({
	blob: z.string(),
	source: z.enum(['stored', 'serialized'])
});
export type RawMetamodel = z.infer<typeof RawMetamodelSchema>;

export const MetamodelLintErrorSchema = z.object({
	message: z.string(),
	line: z.number().int().nullable().default(null),
	column: z.number().int().nullable().default(null)
});
export type MetamodelLintError = z.infer<typeof MetamodelLintErrorSchema>;

export const MetamodelLintSchema = z.object({
	ok: z.boolean(),
	errors: z.array(MetamodelLintErrorSchema).default([])
});
export type MetamodelLint = z.infer<typeof MetamodelLintSchema>;

// Shared canvas positions for the diagram editor: presentation-only,
// last-write-wins, no lease — a missing row from GET /metamodel/layout comes
// back as `{}` rather than 404, so `positions` defaults empty here too.
export const LayoutPositionSchema = z.object({ x: z.number(), y: z.number() });
export const MetamodelLayoutSchema = z.object({
	positions: z.record(z.string(), LayoutPositionSchema).default({})
});
export type MetamodelLayout = z.infer<typeof MetamodelLayoutSchema>;

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
	validation_error_count: z.number().int().default(0),
	// artifact half of the commit delta (headers only — an open editor
	// refetches nothing: the staged payload it just committed IS the payload).
	// Defaults keep every pre-artifact fixture parsing.
	changed_artifacts: z.array(ArtifactHeaderSchema).default([]),
	deleted_artifact_ids: z.array(z.string()).default([]),
	// metamodel half: true when the batch carried a
	// `metamodel.rebind`, in which case the project is bound to a NEW
	// metamodel row named by `to_metamodel_id`. Optional rather than
	// defaulted so a fixture that omits them stays distinguishable from one
	// that says "no rebind" — every reader treats absent as false/null.
	rebound: z.boolean().optional(),
	to_metamodel_id: z.string().nullable().optional(),
	// view half: the new `view_rev` of every view the batch touched, keyed by
	// view id. Informational (see ViewStateResponseSchema.view_rev); optional
	// so pre-existing fixtures keep parsing — readers treat absent as {}.
	view_revs: z.record(z.string(), z.number().int()).optional()
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
// Project artifacts
// ---------------------------------------------------------------------------

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

export interface NavRelationshipStep {
	kind: 'relationship';
	relationship_type: string;
	direction: NavDirection;
	target_types: string[];
	children: NavStepItem[];
	/** Free-form user note explaining the step's intent (evaluator ignores it). */
	comment?: string | null;
}

export interface NavFilterStep {
	kind: 'filter';
	criteria: unknown[]; // search Criterion objects; typed at the editor layer
	/** Free-form user note explaining the step's intent (evaluator ignores it). */
	comment?: string | null;
}

export interface NavPropertyStep {
	kind: 'property';
	property_name: string;
	/** Free-form user note explaining the step's intent (evaluator ignores it). */
	comment?: string | null;
}

export interface NavScriptStep {
	kind: 'script';
	snippet: SnippetSource;
	comment?: string | null;
}

export type NavStepItem = NavRelationshipStep | NavFilterStep | NavPropertyStep | NavScriptStep;

/** Start = the element(s) the caller roots this navigation at — a table
 * column supplies its row's element(s). Mirrors core/navigation/schema.py's
 * RowStart; only valid where a row binding exists (embedded column editors),
 * never in a standalone saved navigation. */
export interface NavRowStart {
	kind: 'row';
}

export interface PathNavigation {
	kind: 'path';
	schema_version: number;
	/** User-chosen display name; null/absent keeps the automatic lettering
	 * ("Path A", "Path B", ...). */
	name?: string | null;
	start: NavScope | SetExpression | NavRowStart;
	steps: NavStepItem[];
	// Cycle guard: when true (default), a chain never revisits an element
	// already in its own prefix; when false, revisits are allowed. Part of
	// the saved definition — mirrors core/navigation/schema.py.
	exclude_visited: boolean;
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
			schema_version: z.number().int().default(2),
			// z.object STRIPS undeclared keys — the user-chosen path name must be
			// declared here or reopening a saved navigation would silently drop it.
			name: z.string().nullable().optional(),
			start: z.unknown(),
			steps: z.array(z.unknown()).default([]),
			// Old saved payloads predate this field; default matches the
			// backend's prior (and still-default) behavior.
			exclude_visited: z.boolean().default(true)
		}),
		z.object({
			kind: z.literal('set_op'),
			schema_version: z.number().int().default(2),
			op: z.enum(['union', 'intersection', 'difference', 'symmetric_difference']),
			operands: z.array(z.unknown()).default([])
		})
	])
) as z.ZodType<NavigationDefinition>;

export const ArtifactSchema = ArtifactHeaderSchema.extend({
	payload: z.record(z.string(), z.unknown()).default({})
});
export type Artifact = z.infer<typeof ArtifactSchema>;

/** Terminal VALUE node in a chain: a scalar property step — or a script step
 * whose `step()` returned something that names no element — ends its chain at
 * that value instead of an element (discriminated from TreeItem by the `kind`
 * tag — TreeItem has no `kind`). */
export const ChainValueSchema = z.object({
	kind: z.literal('value'),
	value: z.union([z.string(), z.number(), z.boolean()])
});
export type ChainValue = z.infer<typeof ChainValueSchema>;

export const ChainNodeSchema = z.union([ChainValueSchema, TreeItemSchema]);
export type ChainNode = z.infer<typeof ChainNodeSchema>;

/** Structured script-degradation warning (nav step failures, a snippet the
 * navigation references that no longer exists, etc). The backend ships codes
 * + counts, not sentences — see
 * `$lib/script/warnings.ts` for the copy that renders these. */
export const ScriptWarningSchema = z.object({
	// Deliberately z.string(), not an enum: a server that ships a new code
	// must not fail validation on an older client. The formatter degrades.
	code: z.string(),
	occurrences: z.number().int().default(1),
	total: z.number().int().default(0),
	detail: z
		.string()
		.nullish()
		.transform((v) => v ?? null)
});
export type ScriptWarning = z.infer<typeof ScriptWarningSchema>;

export const ChainPageSchema = z.object({
	step_types: z.array(z.string()).default([]),
	chains: z.array(z.array(ChainNodeSchema)).default([]),
	total: z.number().int().default(0),
	truncated: z.boolean().default(false),
	warnings: z.array(ScriptWarningSchema).default([])
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

/** The six op buckets a change request / commit diff carries per entity kind
 * (`CrOps` on the server). */
export const CrOpsSchema = z.object({
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
});
export type CrOps = z.infer<typeof CrOpsSchema>;

/**
 * GET /model/changes: the session op log compacted into a `datarover.cr/v1`
 * change request (the `ChangeRequest` shape in `$lib/state/cr.ts`) plus
 * `complete` — false when op-log truncation means the document
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
	ops: CrOpsSchema,
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

/** POST /model/compare — the session → other-model change request. */
export const CompareOutSchema = z.object({
	model_rev: z.number().int(),
	cr: ChangesDocSchema,
	other_element_count: z.number().int(),
	other_relationship_count: z.number().int()
});
export type CompareOut = z.infer<typeof CompareOutSchema>;

/**
 * POST /model/apply-cr — dry-run proposal. `ops` is the staged-buffer wire
 * format (`state/ops.ts` ModelOp); typed loosely here like SnippetRunOut and
 * narrowed by the client module.
 */
export const ProposeCrOutSchema = z.object({
	model_rev: z.number().int(),
	cr: ChangesDocSchema,
	ops: z.array(z.record(z.string(), z.unknown()))
});

/** The 409 body of POST /model/apply-cr: the FIRST CR that could not apply. */
export const ProposeCrConflictSchema = z.object({
	cr_index: z.number().int(),
	conflicts: z.array(ConflictSchema),
	model_rev: z.number().int()
});

// ---------------------------------------------------------------------------
// Snippet execution — mirrors api/schemas.py SnippetRunOut/SnippetLintOut.
// ---------------------------------------------------------------------------

export const SnippetErrorSchema = z.object({
	kind: z.enum(['syntax', 'runtime', 'timeout', 'cancelled', 'memory', 'limit']),
	message: z.string(),
	traceback: z.string().nullable().default(null)
});
export type SnippetError = z.infer<typeof SnippetErrorSchema>;

export const SnippetDiagnosticSchema = z.object({
	line: z.number().int(),
	col: z.number().int(),
	severity: z.enum(['error', 'warning']),
	message: z.string()
});
export type SnippetDiagnostic = z.infer<typeof SnippetDiagnosticSchema>;

export const SnippetLintOutSchema = z.object({
	diagnostics: z.array(SnippetDiagnosticSchema),
	entry_points: z.array(z.string())
});
export type SnippetLintOut = z.infer<typeof SnippetLintOutSchema>;

/** `changed` is false when the snippet was already formatted — the editor
 * skips the replacement transaction (and its undo entry) in that case. */
export const SnippetFormatOutSchema = z.object({
	code: z.string(),
	changed: z.boolean()
});
export type SnippetFormatOut = z.infer<typeof SnippetFormatOutSchema>;

/** Wire shape; `ops` is refined to `Op[]` in api/snippets.ts (types.ts cannot
 * import state/ops — state/ops imports Element/Relationship from here). */
export const SnippetRunOutSchema = z.object({
	run_id: z.string(),
	stdout: z.string(),
	result_repr: z.string().nullable(),
	ops: z.array(z.record(z.string(), z.unknown())),
	error: SnippetErrorSchema.nullable(),
	duration_ms: z.number().int(),
	model_rev: z.number().int(),
	stale: z.boolean(),
	truncated: z.boolean()
});

export const FacadeDocEntrySchema = z.object({
	name: z.string(),
	kind: z.enum(['function', 'method', 'property', 'exception']),
	signature: z.string(),
	doc: z.string(),
	example: z.string().nullable().default(null)
});
export type FacadeDocEntry = z.infer<typeof FacadeDocEntrySchema>;

export const SnippetLimitsSchema = z.object({
	wall_timeout_s: z.number(),
	memory_bytes: z.number(),
	stdout_bytes: z.number(),
	result_repr_bytes: z.number(),
	max_ops: z.number(),
	max_op_bytes: z.number(),
	page_limit: z.number()
});

export const SnippetDocsOutSchema = z.object({
	facade: z.array(FacadeDocEntrySchema).default([]),
	limits: SnippetLimitsSchema,
	notes: z.array(z.string()).default([])
});
export type SnippetDocsOut = z.infer<typeof SnippetDocsOutSchema>;

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

/**
 * GET /commits/{rev}/diff — the model half only. The server also ships
 * artifact/view/metamodel sections; zod strips what is not declared here, so
 * adding a section later is a schema change, not a parse failure.
 */
export const CommitDiffSchema = z.object({
	rev: z.number(),
	commit_id: z.string(),
	scope: z.array(z.string()).default([]),
	is_rebind: z.boolean().default(false),
	elements: CrOpsSchema.shape.elements,
	relationships: CrOpsSchema.shape.relationships
});
export type CommitDiff = z.infer<typeof CommitDiffSchema>;

export const ProjectSettingsSchema = z.object({
	strict_mode: z.boolean()
});
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

// ---------------------------------------------------------------------------
// Table definition — mirrors core/table/schema.py. Navigation
// sources reuse NavigationDefinitionSchema (above); row/column criteria reuse
// the loose `unknown[]` convention NavScope/NavFilterStep already use for
// search Criterion objects (typed at the editor layer, not here).
// ---------------------------------------------------------------------------

export const NavigationSourceSchema = z.object({
	ref: z.string().nullish(),
	definition: NavigationDefinitionSchema.nullish()
});

const RowSlotSchema = z.object({
	kind: z.literal('row'),
	chain_index: z.number().int().default(0)
});
const ColumnRefSchema = z.object({
	kind: z.literal('column'),
	index: z.number().int(),
	// only meaningful when the referenced column is a navigation column: the
	// chain step this reference reads (null = the column's own projection)
	step_index: z.number().int().nullish()
});
export const ColumnSourceSchema = z.discriminatedUnion('kind', [RowSlotSchema, ColumnRefSchema]);

/** Mirror of core/table/schema.py's ScriptInput: a named earlier column a
 *  script column reads for the same row (`value(elements, inputs)`). */
export const ScriptInputSchema = z.object({
	name: z.string(),
	ref: ColumnRefSchema
});
export type ScriptInput = z.infer<typeof ScriptInputSchema>;

export const SnippetDefinitionSchema = z.object({
	schema_version: z.number().int().default(1),
	language: z.literal('python').default('python'),
	code: z.string(),
	entry_points: z.array(z.string()).default([])
});

/** Mirror of core/script/schema.py's `SnippetSource`: a saved snippet `ref`
 *  XOR inline `definition`. NEITHER set (`{}`) is legal and UNCONFIGURED — the
 *  editors create the item before the user picks its snippet. BOTH set is
 *  ambiguous, not incomplete, and is refused here as it is server-side; a
 *  nullish half counts as not set. */
export const SnippetSourceSchema = z
	.object({
		ref: z.string().nullish(),
		definition: SnippetDefinitionSchema.nullish()
	})
	.refine((s) => s.ref == null || s.definition == null, {
		message: 'provide at most one of `ref` / `definition`'
	});
export type SnippetSource = z.infer<typeof SnippetSourceSchema>;

/** Per-column JSON-export settings. Mirrors core/table/schema.py's
 *  JsonColumnOptions. `group` is honored by the backend only on a VISIBLE
 *  EXPAND column; a stale flag elsewhere is ignored, not rejected. `key` names
 *  the column at its home level (the ARRAY, once grouped) and `item_key` names
 *  its own value inside that array's entries; blank falls back to `key`. */
export const JsonColumnOptionsSchema = z.object({
	key: z.string().default(''),
	item_key: z.string().default(''),
	value: z.enum(['name', 'id', 'object']).default('name'),
	group: z.boolean().default(false),
	/** One value instead of an array: empty -> null, one item -> that item
	 *  (an element per `value`, a value as is), more -> the export 422s
	 *  naming the column. */
	single: z.boolean().default(false)
});
export type JsonColumnOptions = z.infer<typeof JsonColumnOptionsSchema>;

/** Per-column export overrides. Mirrors core/table/schema.py's
 *  ColumnExportOptions. `include: null` means "follow `hidden`", which is what
 *  keeps every pre-existing table exporting unchanged. `header` renames the
 *  column for XLSX only — JSON renames through `json_export.key`. */
export const ColumnExportOptionsSchema = z.object({
	include: z.boolean().nullish(),
	header: z.string().default('')
});
export type ColumnExportOptions = z.infer<typeof ColumnExportOptionsSchema>;

/** Export overrides for the row-number pseudo-column. On the definition, not a
 *  column, because there is no Column to hang it off. Blank names fall back to
 *  "#" (xlsx) and "row_number" (JSON). */
export const RowNumberExportOptionsSchema = z.object({
	include: z.boolean().default(true),
	header: z.string().default(''),
	key: z.string().default('')
});
export type RowNumberExportOptions = z.infer<typeof RowNumberExportOptionsSchema>;

const ScriptColumnSchema = z.object({
	kind: z.literal('script'),
	source: ColumnSourceSchema.default({ kind: 'row', chain_index: 0 }),
	snippet: SnippetSourceSchema.default({}),
	inputs: z.array(ScriptInputSchema).default([]),
	mode: z.enum(['collapse', 'expand']).default('collapse'),
	keep_empty: z.boolean().default(true),
	header: z.string().default(''),
	width_px: z.number().int().nullish(),
	hidden: z.boolean().default(false),
	json_export: JsonColumnOptionsSchema.nullish(),
	export: ColumnExportOptionsSchema.nullish()
});

export const ScopeRowsSchema = z.object({
	kind: z.literal('scope'),
	types: z.array(z.string()).default([]),
	criteria: z.array(z.unknown()).default([])
});
export const NavigationRowsSchema = z.object({
	kind: z.literal('navigation'),
	navigation: NavigationSourceSchema,
	step_index: z.number().int().nullish()
});
export const ChainRowsSchema = z.object({
	kind: z.literal('chains'),
	navigation: NavigationSourceSchema,
	// Old saved payloads predate this field; default keeps their
	// one-row-per-chain behavior.
	unique: z.boolean().default(false)
});
export const RowSourceSchema = z.discriminatedUnion('kind', [
	ScopeRowsSchema,
	NavigationRowsSchema,
	ChainRowsSchema
]);

const ElementColumnSchema = z.object({
	kind: z.literal('element'),
	source: ColumnSourceSchema.default({ kind: 'row', chain_index: 0 }),
	header: z.string().default(''),
	width_px: z.number().int().nullish(),
	hidden: z.boolean().default(false),
	json_export: JsonColumnOptionsSchema.nullish(),
	export: ColumnExportOptionsSchema.nullish()
});
const PropertyColumnSchema = z.object({
	kind: z.literal('property'),
	source: ColumnSourceSchema.default({ kind: 'row', chain_index: 0 }),
	name: z.string(),
	mode: z.enum(['collapse', 'expand']).default('collapse'),
	keep_empty: z.boolean().default(true),
	header: z.string().default(''),
	width_px: z.number().int().nullish(),
	hidden: z.boolean().default(false),
	json_export: JsonColumnOptionsSchema.nullish(),
	export: ColumnExportOptionsSchema.nullish()
});
const NavigationColumnSchema = z.object({
	kind: z.literal('navigation'),
	source: ColumnSourceSchema.default({ kind: 'row', chain_index: 0 }),
	navigation: NavigationSourceSchema,
	step_index: z.number().int().nullish(),
	mode: z.enum(['collapse', 'expand']).default('collapse'),
	keep_empty: z.boolean().default(true),
	sort_mode: z.enum(['value', 'count']).default('value'),
	cell_cap: z.number().int().default(20),
	header: z.string().default(''),
	width_px: z.number().int().nullish(),
	hidden: z.boolean().default(false),
	json_export: JsonColumnOptionsSchema.nullish(),
	export: ColumnExportOptionsSchema.nullish()
});
export const ColumnSchema = z.discriminatedUnion('kind', [
	ElementColumnSchema,
	PropertyColumnSchema,
	NavigationColumnSchema,
	ScriptColumnSchema
]);

/** Per-element split for JSON export: one file per base element, zipped.
 *  Mirrors core/table/split.py. `filename_template` must contain the
 *  `${name}` token — validated by `templateIsValid` in `$lib/table/columns`. */
export const JsonSplitOptionsSchema = z.object({
	enabled: z.boolean().default(false),
	filename_template: z.string().default('')
});
export type JsonSplitOptions = z.infer<typeof JsonSplitOptionsSchema>;

/** A `{ref}` artifact reference — mirror of core/table/schema.py::TableRef.
 *  A plain pointer to a committed artifact, with no inline alternative: the
 *  shape of an exporter entry's source table. `transform` does NOT use it —
 *  it takes a `SnippetSource`, which also admits inline code. */
export const TableRefSchema = z.object({ ref: z.string() });
export type TableRef = z.infer<typeof TableRefSchema>;

export const TableDefinitionSchema = z.object({
	schema_version: z.number().int().default(1),
	row_source: RowSourceSchema,
	columns: z.array(ColumnSchema).min(1),
	default_cell_mode: z.enum(['collapse', 'expand']).default('collapse'),
	show_row_numbers: z.boolean().default(false),
	export_order: z.array(z.number().int()).default([]),
	// The grid's column order (definition indices; `[]` = definition order).
	// Presentation only, normalized on read like `export_order` — see
	// `lib/table/export-layout.ts::displayOrder`. An export with no explicit
	// `export_order` follows it.
	display_order: z.array(z.number().int()).default([]),
	export_row_number: RowNumberExportOptionsSchema.nullish(),
	json_split: JsonSplitOptionsSchema.nullish(),
	// JSON-family only (json/jsonl); strict at export time (422/503/429 from
	// POST /exports/run), never validated client-side, never blocks Save.
	// `null` means "no transform" — never "inherit the table's" (no-bleed).
	transform: SnippetSourceSchema.nullish()
});
export type TableDefinition = z.infer<typeof TableDefinitionSchema>;
export type Column = z.infer<typeof ColumnSchema>;
export type RowSource = z.infer<typeof RowSourceSchema>;
export type ColumnSource = z.infer<typeof ColumnSourceSchema>;

// ---- Exporter (kind='exporter' artifact payload) ----------------------------
// Wire mirror of core/table/exporter.py. A named collection of table
// exports whose presentation overrides live IN the artifact, keyed by column
// index against each source table's CURRENT definition (see
// $lib/table/exporter.ts for the apply/copy helpers).
export const ColumnOverrideSchema = z.object({
	index: z.number().int().nonnegative(),
	export: ColumnExportOptionsSchema.nullish(),
	json_export: JsonColumnOptionsSchema.nullish()
});
export type ColumnOverride = z.infer<typeof ColumnOverrideSchema>;

/** The four wire formats an export can ship as — mirror of
 *  core/table/exporter.py::ExportFormat. */
export const EXPORT_FORMATS = ['xlsx', 'json', 'csv', 'jsonl'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** ONE spelling for the "json family" gate — json + jsonl render through the
 *  same document list; csv/xlsx take the layout path. Mirror of
 *  core/table/exporter.py::JSON_FAMILY. */
export function isJsonFamily(format: ExportFormat): boolean {
	return format === 'json' || format === 'jsonl';
}

/** Document shaping for JSON exports — exporter-entry-only.
 *  `shape`/`pretty` apply to `json`; `on_error` to `json` and `jsonl`;
 *  ignored elsewhere. All strictness (missing/out-of-range/duplicate keys,
 *  on_error 'fail') is a 422 from POST /exports/run — never validated
 *  client-side, never blocks Save. */
export const JsonDocumentOptionsSchema = z.object({
	shape: z.enum(['array', 'object']).default('array'),
	key_column: z.number().int().nullish(),
	pretty: z.boolean().default(true),
	on_error: z.enum(['emit', 'fail']).default('emit')
});
export type JsonDocumentOptions = z.infer<typeof JsonDocumentOptionsSchema>;

export const ExporterEntrySchema = z.object({
	source: TableRefSchema,
	name: z.string().default(''),
	format: z.enum(EXPORT_FORMATS).default('xlsx'),
	folder: z.string().default(''),
	// Split entries only: nest the per-element files under `{folder}/{name}/`
	// (true) or land them directly in `folder` (false).
	split_folder: z.boolean().default(true),
	columns: z.array(ColumnOverrideSchema).default([]),
	export_order: z.array(z.number().int()).default([]),
	show_row_numbers: z.boolean().default(false),
	export_row_number: RowNumberExportOptionsSchema.nullish(),
	json_split: JsonSplitOptionsSchema.nullish(),
	json_doc: JsonDocumentOptionsSchema.nullish(),
	// JSON-family only (json/jsonl); strict at export time (422/503/429 from
	// POST /exports/run), never validated client-side, never blocks Save.
	// `null` means "no transform" — never "inherit the table's" (no-bleed).
	transform: SnippetSourceSchema.nullish()
});
export type ExporterEntry = z.infer<typeof ExporterEntrySchema>;

/** Zip-level output settings for an exporter artifact. `filename` and each
 *  entry's `folder` are `${token}` templates rendered server-side at export
 *  time (`${name}`/`${rev}`/`${date}`/`${project}`) — an unknown token, a bad
 *  path, or bare-mode-with-many-files is a 422 from `POST /exports/run`, not
 *  a client-side validation error. Never validate these client-side. */
export const OutputOptionsSchema = z.object({
	mode: z.enum(['zip', 'bare']).default('zip'),
	filename: z.string().default(''),
	manifest: z.boolean().default(true)
});
export type OutputOptions = z.infer<typeof OutputOptionsSchema>;

/** `POST /exports/preview-transform` — mirror of api/schemas.py
 *  TransformPreviewFileOut/TransformPreviewOut. One entry per file the export
 *  would write: `filename` is the export's member name; `input`/`output` are
 *  pretty-printed JSON TEXT rendered server-side (never re-serialized here);
 *  `output` is null iff `error` is set. Unsplit there is exactly one file
 *  (`truncated` = sample covers only the head of the table); `split` is the
 *  full run, one file per partition (`truncated` = more files than the cap). */
export const TransformPreviewFileOutSchema = z.object({
	filename: z.string(),
	input: z.string(),
	output: z.string().nullable(),
	stdout: z.string(),
	error: SnippetErrorSchema.nullable(),
	duration_ms: z.number()
});
export type TransformPreviewFileOut = z.infer<typeof TransformPreviewFileOutSchema>;
export const TransformPreviewOutSchema = z.object({
	files: z.array(TransformPreviewFileOutSchema),
	split: z.boolean(),
	truncated: z.boolean(),
	duration_ms: z.number()
});
export type TransformPreviewOut = z.infer<typeof TransformPreviewOutSchema>;

export const ExporterDefinitionSchema = z.object({
	schema_version: z.number().default(1),
	output: OutputOptionsSchema.default({ mode: 'zip', filename: '', manifest: true }),
	entries: z.array(ExporterEntrySchema).default([])
});
export type ExporterDefinition = z.infer<typeof ExporterDefinitionSchema>;

// ---- Table page (evaluate response) ----------------------------------------
export const TableColumnSchema = z.object({
	kind: z.string(),
	header: z.string(),
	width_px: z.number().int().nullish()
});
export const TableCellSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('element'), item: TreeItemSchema.nullable() }),
	z.object({
		kind: z.literal('value'),
		present: z.boolean(),
		value: z.unknown().nullable(),
		element_id: z.string().nullable(),
		editable: z.boolean()
	}),
	z.object({
		kind: z.literal('values'),
		present: z.boolean(),
		values: z.array(z.unknown()),
		total: z.number().int(),
		truncated: z.boolean()
	}),
	z.object({
		kind: z.literal('elements'),
		items: z.array(TreeItemSchema),
		total: z.number().int(),
		truncated: z.boolean()
	}),
	z.object({ kind: z.literal('error'), message: z.string(), traceback: z.string().nullish() }),
	// A cell whose script value hasn't been computed by the background sweep
	// yet (core/table's cache-only evaluate path). No other fields — the
	// client polls script_status and/or re-evaluates until it resolves.
	z.object({ kind: z.literal('pending') })
]);
export const TableRowSchema = z.object({
	key: z.array(z.unknown()),
	cells: z.array(TableCellSchema)
});

/** Progress of the background script-cache sweep for a table's script
 * column(s). Absent/null for tables with no script column, or for older
 * backend responses that predate this field. */
export const ScriptStatusSchema = z.object({
	state: z.enum(['ready', 'computing', 'failed']),
	done: z.number().int().default(0),
	total: z.number().int().nullish(),
	message: z.string().nullish()
});
export type ScriptStatus = z.infer<typeof ScriptStatusSchema>;

export const TablePageSchema = z.object({
	columns: z.array(TableColumnSchema),
	rows: z.array(TableRowSchema),
	total: z.number().int(),
	// rows the row source produced BEFORE expand columns split them (for a
	// scope source: the scope size); nullish-tolerant for older responses
	base_total: z.number().int().nullish(),
	truncated: z.boolean(),
	offset: z.number().int(),
	model_rev: z.number().int(),
	warnings: z.array(ScriptWarningSchema).default([]),
	script_status: ScriptStatusSchema.nullish()
});
export type TablePage = z.infer<typeof TablePageSchema>;
export type TableCell = z.infer<typeof TableCellSchema>;
export type TableColumn = z.infer<typeof TableColumnSchema>;
export type TableRow = z.infer<typeof TableRowSchema>;
export type TableSort = { column: number; direction: 'asc' | 'desc' };

/**
 * One failing script cell in a table's whole-table error recap
 * (`POST /tables/script-errors`, api/schemas.py's `ScriptErrorItemOut`).
 *
 * `row_index` is a GRID ADDRESS — the row's position in the very order the
 * page route would render for the same `(definition, sort, model_rev)`, which
 * is what makes jump-to-cell land on the right row. It is only valid for that
 * triple: send the sort the grid is showing, and re-fetch when the rev moves.
 * `column_index` indexes the DEFINITION's columns (hidden columns are not
 * filtered out), so it lines up with `TablePage.columns` / `TableRow.cells`.
 *
 * `message` is `"not computed"` for a cell that no longer has any chance of
 * being computed at this rev — the same wording the degraded xlsx export
 * renders as `#ERROR: not computed`.
 */
export interface ScriptErrorItem {
	row_index: number;
	row_element_id: string | null;
	row_label: string | null;
	column_index: number;
	column_label: string;
	message: string;
}

/**
 * The recap body itself (`ScriptErrorsOut`). `truncated` means `errors` was
 * capped server-side while `total_errors` is the true count, so the panel says
 * "showing first N". `state` is a one-valued literal: the 200 body is always
 * `ready`, and the retry signal for a still-computing sweep is the 202 STATUS
 * CODE, never a body field (see `fetchScriptErrors`).
 */
export interface ScriptErrorsRecap {
	state: 'ready';
	errors: ScriptErrorItem[];
	total_errors: number;
	truncated: boolean;
}
