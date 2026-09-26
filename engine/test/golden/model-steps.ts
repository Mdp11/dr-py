import { createHash } from 'node:crypto';
import { expect } from 'vitest';
import {
	appliesPopulation,
	applyBatch,
	ArtifactSet,
	cmpCodePoint,
	compileRuleSets,
	DirtyCollector,
	drain,
	EMPTY_RULES,
	expandScope,
	dumpIndexes,
	elementLine,
	ElementRec,
	evaluateNavigationCore,
	EVALUATIONS,
	FacetPatterns,
	isSteps,
	IssueStore,
	LiveIssues,
	Metamodel,
	Model,
	ModelError,
	modelDigest,
	modelLines,
	NavKeyError,
	NavValueError,
	navigationFetch,
	navigationHasScript,
	OpError,
	parseJson,
	PyFloat,
	previewBody,
	pyRepr,
	pyDumps,
	readArtifacts,
	ReadError,
	readNavigation,
	READS,
	relationshipLine,
	RelRec,
	resolveRefs,
	ruleSources,
	rulesStatusBody,
	shuffleAdjacency,
	storeListBody,
	validateBody,
	validateScoped,
	Validators,
	verifyConsistent,
	ViewPlacements,
	wireIssue,
	type BatchResult,
	type ChainNode,
	type CommittedArtifact,
	type CompiledRules,
	type ElementImage,
	type ExportFileResult,
	type MetamodelDoc,
	type ModelOp,
	type ModelOptions,
	type Props,
	type ReadParams,
	type RelImage,
	type StagedArtifact,
	type Value,
	buildRowsSteps,
	cellText,
	DEFAULT_TABLE_LIMITS,
	evaluateCellsSteps,
	Meter,
	NavMemo,
	orderRowsSteps,
	PropertyValue,
	readTableDefinition,
	resolveTableRefs,
	tableHasScript,
	toWire,
	type RowKey,
	type TableLimits,
	type Wire
} from '../../src/index.ts';
import { clone, workingCopy } from '../working/helpers.ts';
import { untag, type Tagged } from './load.ts';

/**
 * What `tests/golden/model_steps.py` records of the model after a step: always
 * the digest and a fingerprint of lines plus index dump; at a checkpoint the
 * lines and the dump too.
 */
export type Observed = { digest: string; fingerprint: string; state?: string[]; indexes?: string };

/**
 * What a landed batch reports: ops, images and entities as lines of the
 * server's JSON text, and with them the delta a replica would be sent.
 */
export type BatchOutcome = {
	id_map: [string, string][];
	dirty?: string[];
	changed_element_ids: string[];
	changed_relationship_ids: string[];
	deleted_element_ids: string[];
	deleted_relationship_ids: string[];
	recreated_element_ids: string[];
	recreated_relationship_ids: string[];
	before_elements: [string, string | null][];
	before_relationships: [string, string | null][];
	inverse_ops: string[];
	changed_elements: string[];
	changed_relationships: string[];
};

/** A route's refusal; a list `detail` is FastAPI's own, of a body it cannot read. */
export type StepError =
	{ kind: 'key' | 'value'; message: string } | { status: number; detail: string | unknown[] };

export type Step = Partial<Observed> & {
	do: string;
	id?: string;
	type?: string;
	prop?: string;
	source?: string;
	target?: string;
	value?: Tagged;
	detached?: 'element' | 'relationship';
	/** `batch`: the ops, one line of JSON text each; `restore` reinstates exact ids. */
	ops?: string[];
	restore?: boolean;
	/** `batch` / `undo`: the result carries the dirty ids, in the order collected. */
	record_dirty?: boolean;
	/** `batch`: those dirty ids widened by the compiled rules' reach. */
	expand?: boolean;
	/** `rules`: the rule sets to compile, in the order both sides compile them. */
	sources?: { artifact_id: string; name: string; yaml: string }[];
	/** `reach`: the ids to reach back from. */
	ids?: string[];
	/** `undo`: the index of the landed batch whose inverse ops to run. */
	of?: number;
	/** `read`: a method of `READS` or of `EVALUATIONS`, and its params; `export`: a method of `EVALUATIONS`. */
	method?: string;
	params?: ReadParams;
	/** `read` / `export`: the name of the recorded case. */
	case?: string;
	/** `export`: the route's body, and the day its clock read. */
	body?: ReadParams;
	date?: string;
	/** `view` / `drop_view`: the view whose placements `result` lists / to forget. */
	view_id?: string;
	/** `artifacts`: the project's committed artifacts from here on, by id. */
	artifacts?: { [id: string]: { kind: string; payload: Tagged } };
	/** `navigate` / `has_script` / `table_rows` / `cell_text`: a definition whose refs resolve against those artifacts. */
	definition?: unknown;
	/** `navigate`'s evaluator limits, or `table_rows`' and `cell_text`'s table limits. */
	limits?: NavigateLimits | TableStepLimits;
	/** `cell_text`: the page of rows rendered. */
	offset?: number;
	limit?: number;
	row_elements?: string[] | null;
	/** `preview`: the session's strict mode. */
	strict?: boolean;
	/** `validate`: the ids to validate, in order, or every id in state order. */
	scope?: string[] | 'all_ids';
	/** `insert_element` / `insert_relationship`: the entity's `rev`; `value` holds its properties. */
	rev?: number;
	result: string | string[] | BatchOutcome | object | boolean | null;
	error: StepError | null;
	unchanged?: true;
};

export type NavigateLimits = { max_visited: number; max_chains: number };
export type TableStepLimits = { max_rows: number; max_cell_elements: number };

export type StepsFixture = { metamodel: MetamodelDoc; steps: Step[] };

/** Where a replay puts the artifacts of an `artifacts` step. */
export type ArtifactLayer = 'committed' | 'staged';

/** A small seeded generator (mulberry32): test runs must be repeatable. */
export function seededRandom(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function fingerprint(state: readonly string[], indexes: string): string {
	const text = state.join('\n') + '\n' + indexes;
	return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/** The engine's side of `Observed`, the index dump as the oracle's compact JSON text. */
export function observe(model: Model): Required<Observed> {
	const state = modelLines(model);
	const indexes = pyDumps(dumpIndexes(model));
	return { digest: modelDigest(model), fingerprint: fingerprint(state, indexes), state, indexes };
}

const sortedIds = (rels: readonly RelRec[]) => rels.map((rel) => rel.id).sort(cmpCodePoint);

function entityOf(model: Model, step: Step): ElementRec | RelRec {
	if (step.detached === 'element') return new ElementRec(step.id!, step.type!, {}, 0, -1);
	if (step.detached === 'relationship') {
		const nowhere = new ElementRec('', '', {}, 0, -1);
		return new RelRec(step.id!, step.type!, nowhere, nowhere, {}, 0, -1);
	}
	return model.findElement(step.id!) ?? model.getRelationship(step.id!);
}

export const parseOps = (lines: readonly string[]) =>
	lines.map((line) => parseJson(line) as unknown as ModelOp);

const elementImageLine = (image: ElementImage) =>
	pyDumps({ id: image.id, type_name: image.typeName, properties: image.props, rev: image.rev });

const relImageLine = (image: RelImage) =>
	pyDumps({
		id: image.id,
		type_name: image.typeName,
		source_id: image.sourceId,
		target_id: image.targetId,
		properties: image.props,
		rev: image.rev
	});

/** The engine's side of `BatchOutcome`, every line rendered by the engine's own serializer. */
export function outcome(model: Model, res: BatchResult): BatchOutcome {
	return {
		id_map: [...res.idMap],
		changed_element_ids: [...res.changedElementIds],
		changed_relationship_ids: [...res.changedRelationshipIds],
		deleted_element_ids: [...res.deletedElementIds],
		deleted_relationship_ids: [...res.deletedRelationshipIds],
		recreated_element_ids: [...res.recreatedElementIds],
		recreated_relationship_ids: [...res.recreatedRelationshipIds],
		before_elements: [...res.beforeElements].map(([id, image]) => [
			id,
			image === null ? null : elementImageLine(image)
		]),
		before_relationships: [...res.beforeRelationships].map(([id, image]) => [
			id,
			image === null ? null : relImageLine(image)
		]),
		inverse_ops: res.inverseOps().map((op) => pyDumps(op as unknown as Value)),
		changed_elements: [...res.changedElementIds].map((id) => elementLine(model.getElement(id))),
		changed_relationships: [...res.changedRelationshipIds].map((id) =>
			relationshipLine(model.getRelationship(id))
		)
	};
}

/**
 * What a replay carries from step to step: the batches that landed, by step
 * index, the views, the artifacts with the layer they go into, the rules of
 * the last `rules` step, and once a `seed` step ran, the session's issue store
 * and `model_rev`.
 */
type Landed = Map<number, BatchResult>;
type Validation = { validators: Validators; patterns: FacetPatterns };
type Carried = {
	landed: Landed;
	placements: ViewPlacements;
	artifacts: ArtifactSet;
	layer: ArtifactLayer;
	validation: Validation | null;
	session: { store: IssueStore; rev: number } | null;
	rules: CompiledRules | null;
	options: ModelOptions;
};

/** `POST /rules/parse`'s body, as a `rules` step records one per source. */
export type RecordedParse = {
	ok: boolean;
	document: string | null;
	errors: { message: string; line: number | null; column: number | null }[];
};

/** What a `rules` step records. */
export type RulesStepResult = { parses: RecordedParse[]; status: unknown; compiled: unknown };

const sortedNames = (names: ReadonlySet<string>) => [...names].sort(cmpCodePoint);

/** `rules_status` as `GET /model/issues` builds it from a compile. */
export function rulesStatus(compiled: CompiledRules): unknown {
	return {
		total: compiled.total,
		skipped: compiled.skipped.map(({ artifact_id, set_name, rule, reason }) => ({
			artifact_id,
			set_name,
			rule,
			reason
		})),
		eval_errors: Object.fromEntries(compiled.evalErrors)
	};
}

/** The recorder's view of a compile: each rule's applies types and paths, the checks per type. */
export function compiledRecord(compiled: CompiledRules): unknown {
	return {
		rules: compiled.rules.map((rule) => ({
			artifact_id: rule.artifactId,
			check: rule.check,
			applies_types: sortedNames(rule.appliesTypes),
			paths: rule.paths.map((path) =>
				path.map((step) => ({
					rel_types: sortedNames(step.relTypes),
					direction: step.direction,
					far_types: step.farTypes === null ? null : sortedNames(step.farTypes)
				}))
			)
		})),
		rules_by_type: Object.fromEntries(
			[...compiled.rulesByType.keys()]
				.sort(cmpCodePoint)
				.map((type) => [type, compiled.rulesByType.get(type)!.map((rule) => rule.check)])
		)
	};
}

/**
 * A `rules` step's sources as the shell hands them in: committed artifacts
 * carrying the parse the server recorded for each, read, laid in a set and
 * listed by `ruleSources`, then compiled over `mm`.
 */
export function compileRecorded(step: Step, mm: Metamodel): CompiledRules {
	const { parses } = step.result as RulesStepResult;
	const set = new ArtifactSet();
	set.setCommitted(
		readArtifacts(
			step.sources!.map((source, i) => ({
				id: source.artifact_id,
				kind: 'validation_rules',
				name: source.name,
				artifact_rev: 1,
				payload: { schema_version: 1, yaml: source.yaml },
				rules: parses[i]
			}))
		)
	);
	return compileRuleSets(ruleSources(set, 'committed'), mm);
}

function validationOf(carried: Carried, model: Model): Validation {
	const mm = model.metamodel;
	return (carried.validation ??= {
		validators: new Validators(mm),
		patterns: new FacetPatterns(mm)
	});
}

/** Every element id in state order, then every relationship id. */
function allIds(model: Model): string[] {
	return [
		...[...model.elements()].map((el) => el.id),
		...[...model.relationships()].map((rel) => rel.id)
	];
}

/** `tests/golden/tagged.py`'s rendering of a value. */
function tag(value: Value): Tagged {
	if (value === null) return { t: 'null' };
	if (typeof value === 'boolean') return { t: 'bool', v: value };
	if (typeof value === 'number' || typeof value === 'bigint') return { t: 'int', v: String(value) };
	if (typeof value === 'string') return { t: 'str', v: value };
	if (value instanceof PyFloat) {
		const view = new DataView(new ArrayBuffer(8));
		view.setFloat64(0, value.value);
		return { t: 'float', hex: view.getBigUint64(0).toString(16).padStart(16, '0') };
	}
	if (Array.isArray(value)) return { t: 'list', v: value.map(tag) };
	return { t: 'dict', v: Object.entries(value).map(([key, item]) => [key, tag(item)]) };
}

const recordedNode = (node: ChainNode) =>
	typeof node === 'string' ? node : { value: tag(node.value) };

function setArtifacts({ artifacts, layer }: Carried, step: Step): void {
	const entries = Object.entries(step.artifacts!).map(([id, { kind, payload }]) => ({
		id,
		kind,
		name: id,
		payload: untag(payload) as CommittedArtifact['payload']
	}));
	if (layer === 'committed') {
		artifacts.setCommitted(entries.map((entry) => ({ ...entry, rev: 1 })));
		artifacts.setStaged([]);
	} else {
		artifacts.setCommitted([]);
		artifacts.setStaged(entries.map((entry): StagedArtifact => ({ op: 'create', ...entry })));
	}
}

/** Row keys as the route writes them: a value terminal as `{"value": …}`. */
const wireKeys = (keys: readonly RowKey[]): Wire[][] =>
	keys.map((key) =>
		key.map((slot) =>
			slot instanceof PropertyValue ? { value: toWire(slot.value) } : toWire(slot)
		)
	);

const resolvedTable = (artifacts: ArtifactSet, step: Step) =>
	resolveTableRefs(readTableDefinition(step.definition, 'definition'), navigationFetch(artifacts));

function tableLimits(step: Step): TableLimits {
	const raw = step.limits as TableStepLimits | undefined;
	return raw === undefined
		? DEFAULT_TABLE_LIMITS
		: { maxRows: raw.max_rows, maxCellElements: raw.max_cell_elements };
}

/**
 * The row build and order of a definition resolved against the artifacts, a
 * table that reaches a script not built; a core `ValueError` or `KeyError`
 * answered as the tables route answers it.
 */
function tableRows(model: Model, artifacts: ArtifactSet, step: Step): unknown {
	const defn = resolvedTable(artifacts, step);
	if (tableHasScript(defn)) {
		return {
			has_script: true,
			keys: null,
			truncated: null,
			base_total: null,
			base_slots: null,
			order: null
		};
	}
	const limits = tableLimits(step);
	const meter = new Meter(0);
	try {
		const built = drain(buildRowsSteps(model, defn, limits, meter, new NavMemo()));
		const order = drain(
			orderRowsSteps(model, defn, built.keys, built.baseSlots, meter, new NavMemo())
		);
		return {
			has_script: false,
			keys: wireKeys(built.keys),
			truncated: built.truncated,
			base_total: built.baseTotal,
			base_slots: built.baseSlots,
			order: wireKeys(order)
		};
	} catch (error) {
		if (error instanceof NavValueError) throw new ReadError(422, error.message);
		if (error instanceof NavKeyError) {
			throw new ReadError(422, `unknown artifact ${pyRepr(error.id)}`);
		}
		throw error;
	}
}

/** One page of a table's cells in its row order, each as an export renders it, tagged. */
function cellTexts(model: Model, artifacts: ArtifactSet, step: Step): Tagged[][] {
	const defn = resolvedTable(artifacts, step);
	const limits = tableLimits(step);
	const meter = new Meter(0);
	const built = drain(buildRowsSteps(model, defn, limits, meter, new NavMemo()));
	const order = drain(
		orderRowsSteps(model, defn, built.keys, built.baseSlots, meter, new NavMemo())
	);
	const offset = step.offset ?? 0;
	const page = order.slice(offset, offset + (step.limit ?? 100));
	const cells = drain(
		evaluateCellsSteps(model, defn, page, built.baseSlots, limits, meter, new NavMemo())
	);
	return cells.map((row) => row.map((cell) => tag(cellText(model, cell))));
}

/** What the recorder keeps of a shipped file: its text, decoded as UTF-8. */
function exported(result: ExportFileResult): unknown {
	const { parts, filename, content_type, truncated } = result;
	const bytes = new Uint8Array(parts.reduce((n, part) => n + part.byteLength, 0));
	let at = 0;
	for (const part of parts) {
		bytes.set(new Uint8Array(part), at);
		at += part.byteLength;
	}
	const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
	return { status: 200, filename, content_type, truncated, file: { text } };
}

/**
 * `mint` stands in for the oracle's `SequentialIdGenerator`. A failed call
 * consumes no id, and neither does a refused batch: the oracle runs each on a
 * copy of its model and drops the copy, generator included.
 */
function apply(
	model: Model,
	step: Step,
	index: number,
	mint: () => string,
	carried: Carried
): unknown {
	const { landed, placements, artifacts } = carried;
	switch (step.do) {
		case 'read': {
			const method = step.method!;
			const params = step.params ?? {};
			if (Object.hasOwn(READS, method)) {
				const out = READS[method]!(model, placements, params);
				return isSteps(out) ? drain(out) : out;
			}
			if (Object.hasOwn(EVALUATIONS, method)) {
				return drain(EVALUATIONS[method]!({ model, artifacts, placements }, params));
			}
			throw new Error(`no read ${method}`);
		}
		case 'validate': {
			const ids = step.scope === 'all_ids' ? allIds(model) : step.scope!;
			const { validators, patterns } = validationOf(carried, model);
			return validateScoped(model, ids, validators, patterns, carried.rules).map((i) =>
				wireIssue(i, 'on_server')
			);
		}
		case 'rules': {
			const compiled = compileRecorded(step, model.metamodel);
			expect(compiled.unreadable, `step ${index}: a document the engine refuses`).toBe(false);
			const { session } = carried;
			if (session !== null) {
				// As a commit of rule sets alone lands: what the old and the new
				// rules apply to, revalidated with the new ones in one run.
				const { validators, patterns } = validationOf(carried, model);
				const ids = appliesPopulation(model, carried.rules ?? EMPTY_RULES, compiled);
				session.store.replace(ids, validateScoped(model, ids, validators, patterns, compiled));
				session.rev += 1;
			}
			carried.rules = compiled;
			const { parses } = step.result as RulesStepResult;
			return { parses, status: rulesStatus(compiled), compiled: compiledRecord(compiled) };
		}
		case 'reach':
			return expandScope(model, carried.rules ?? EMPTY_RULES, step.ids!);
		case 'seed': {
			// The server's sweep: every id, validated and spliced into an empty store.
			const { validators, patterns } = validationOf(carried, model);
			const store = new IssueStore();
			const ids = allIds(model);
			store.replace(ids, validateScoped(model, ids, validators, patterns, carried.rules));
			carried.session = { store, rev: 0 };
			return null;
		}
		case 'issues': {
			const { store, rev } = carried.session!;
			return storeListBody(store, rev, rulesStatusBody(carried.rules ?? EMPTY_RULES));
		}
		case 'preview':
		case 'validate_staged': {
			// A replica of the session's state, its store seeded with the session's
			// and its rules both committed and working, the ops staged on it as one batch.
			const { store, rev } = carried.session!;
			const seed = new IssueStore();
			seed.replace([...store.owners()], [...store.iter()]);
			const rules = carried.rules ?? EMPTY_RULES;
			const live = new LiveIssues(workingCopy(clone(model, carried.options), rev), {
				seed,
				rules: { working: rules, committed: rules }
			});
			const ops = parseOps(step.ops!);
			if (ops.length > 0) live.stage(ops);
			return step.do === 'preview' ? previewBody(live, step.strict!) : validateBody(live);
		}
		case 'artifacts':
			setArtifacts(carried, step);
			return null;
		case 'navigate': {
			const fetch = navigationFetch(artifacts);
			const defn = resolveRefs(readNavigation(step.definition, 'definition'), fetch);
			const { max_visited, max_chains } = step.limits as NavigateLimits;
			const result = evaluateNavigationCore(
				model.metamodel,
				model,
				defn,
				{ maxVisited: max_visited, maxChains: max_chains },
				step.row_elements ?? null
			);
			return {
				step_types: result.stepTypes,
				chains: result.chains.map((chain) => chain.map(recordedNode)),
				truncated: result.truncated
			};
		}
		case 'has_script': {
			const fetch = navigationFetch(artifacts);
			return navigationHasScript(resolveRefs(readNavigation(step.definition, 'definition'), fetch));
		}
		case 'export':
			return exported(
				drain(
					EVALUATIONS[step.method!]!(
						{ model, artifacts, placements },
						{ ...step.body!, date: step.date!, project: 'p' }
					)
				) as ExportFileResult
			);
		case 'table_rows':
			return tableRows(model, artifacts, step);
		case 'cell_text':
			return cellTexts(model, artifacts, step);
		case 'view':
			placements.set(step.view_id!, step.result as string[]);
			return step.result;
		case 'drop_view':
			placements.drop(step.view_id!);
			return null;
		case 'batch':
		case 'undo': {
			const ops = step.do === 'batch' ? parseOps(step.ops!) : landed.get(step.of!)!.inverseOps();
			const restore = step.do === 'undo' || step.restore === true;
			const { session } = carried;
			const dirty =
				step.record_dirty === true || session !== null ? new DirtyCollector() : undefined;
			const res = applyBatch(model, ops, { restore, idFor: mint, dirty });
			landed.set(index, res);
			const out = outcome(model, res);
			if (step.expand === true) {
				dirty!.update(expandScope(model, carried.rules ?? EMPTY_RULES, [...dirty!.ids]));
			}
			if (step.record_dirty === true) out.dirty = [...dirty!.ids];
			if (session !== null) {
				// As the ops route finalizes a landed batch: its dirty scope widened by
				// the rules' reach, revalidated and spliced.
				const { validators, patterns } = validationOf(carried, model);
				dirty!.update(expandScope(model, carried.rules ?? EMPTY_RULES, [...dirty!.ids]));
				session.rev += 1;
				session.store.replace(
					dirty!.ids,
					validateScoped(model, dirty!.ids, validators, patterns, carried.rules)
				);
			}
			return out;
		}
		case 'create_element':
			return model.createElement(step.type!, mint()).id;
		case 'restore_element':
			return model.restoreElement(step.id!, step.type!).id;
		case 'insert_element':
			return model.insertElement(step.id!, step.type!, untag(step.value!) as Props, step.rev!).id;
		case 'insert_relationship':
			return model.insertRelationship(
				step.id!,
				step.type!,
				step.source!,
				step.target!,
				untag(step.value!) as Props,
				step.rev!
			).id;
		case 'get_element':
			return model.getElement(step.id!).id;
		case 'get_relationship':
			return model.getRelationship(step.id!).id;
		case 'set_property':
			model.setProperty(entityOf(model, step), step.prop!, untag(step.value!));
			return null;
		case 'delete_property':
			model.deleteProperty(entityOf(model, step), step.prop!);
			return null;
		case 'connect':
			return model.connect(step.type!, step.source!, step.target!, mint()).id;
		case 'restore_relationship':
			return model.restoreRelationship(step.id!, step.type!, step.source!, step.target!).id;
		case 'disconnect':
			model.disconnect(step.id!);
			return null;
		case 'delete_element':
			model.deleteElement(step.id!);
			return null;
		case 'container_of':
			return model.containerOf(step.id!);
		case 'relationships_from':
			return sortedIds(model.relationshipsFrom(step.id!));
		case 'relationships_to':
			return sortedIds(model.relationshipsTo(step.id!));
	}
	throw new Error(`unknown step ${step.do}`);
}

/** Steps whose result is compared as JSON text. */
const READ_LIKE = new Set([
	'read',
	'export',
	'navigate',
	'has_script',
	'table_rows',
	'cell_text',
	'validate',
	'rules',
	'reach',
	'issues',
	'preview',
	'validate_staged'
]);

/**
 * Replays a recorded scenario through the engine, comparing every outcome and
 * the whole observable state after every step. Adjacency is shuffled before
 * each step and the indexes are checked against a rebuild after it. The
 * artifacts of an `artifacts` step go into `layer`: committed, or staged as
 * creates under their own ids over an empty committed layer.
 */
export function replaySteps(
	fixture: StepsFixture,
	options: ModelOptions = {},
	layer: ArtifactLayer = 'committed'
): void {
	const model = new Model(Metamodel.fromJSON(fixture.metamodel), options);
	const random = seededRandom(20260918);
	const carried: Carried = {
		landed: new Map(),
		placements: new ViewPlacements(),
		artifacts: new ArtifactSet(),
		layer,
		validation: null,
		session: null,
		rules: null,
		options
	};
	let minted = 0;
	let last = observe(model);
	fixture.steps.forEach((step, index) => {
		const label = `step ${index}: ${step.do}`;
		shuffleAdjacency(model, random);
		let result: unknown = null;
		let error: Step['error'] = null;
		const mintedBefore = minted;
		try {
			result = apply(model, step, index, () => `id-${++minted}`, carried);
		} catch (caught) {
			minted = mintedBefore;
			if (caught instanceof ModelError) error = { kind: caught.kind, message: caught.message };
			else if (caught instanceof OpError) error = { status: caught.status, detail: caught.detail };
			else if (caught instanceof ReadError) {
				error = { status: caught.status, detail: caught.detail };
			} else if (caught instanceof NavKeyError) error = { kind: 'key', message: caught.id };
			else if (caught instanceof NavValueError) error = { kind: 'value', message: caught.message };
			else throw caught;
		}
		const recorded = step.error;
		if (recorded !== null && 'status' in recorded && typeof recorded.detail !== 'string') {
			// FastAPI's refusal of a body: the engine refuses it in its own words.
			expect(error !== null && 'status' in error ? error.status : error, label).toBe(
				recorded.status
			);
		} else expect(error, label).toEqual(recorded);
		// A body is compared as text: values and key order at once.
		if (READ_LIKE.has(step.do)) {
			expect(JSON.stringify(result), label).toBe(JSON.stringify(step.result));
		} else expect(result, label).toEqual(step.result);
		const seen = observe(model);
		if (step.unchanged) {
			expect(seen, label).toEqual(last);
		} else {
			if (step.state !== undefined) {
				// A checkpoint: compare what can be read before what can only be seen.
				expect(seen.state, label).toEqual(step.state);
				expect(JSON.parse(seen.indexes), label).toEqual(JSON.parse(step.indexes!));
			}
			expect(seen.digest, label).toBe(step.digest);
			expect(seen.fingerprint, label).toBe(step.fingerprint);
		}
		verifyConsistent(model);
		expect(observe(model), `${label}, after a rebuild`).toEqual(seen);
		last = seen;
	});
}
