import { Metamodel } from '../metamodel/metamodel.ts';
import type { MetamodelDoc } from '../metamodel/types.ts';
import type { Model } from '../model/model.ts';
import { candidateStructureSteps } from '../model/structure.ts';
import type { CompiledRules } from '../rules/compile.ts';
import { RulesUnreadable } from '../rules/document.ts';
import type { Steps } from '../steps/steps.ts';
import type { PreviewBody } from './bodies.ts';
import { candidateKey, wireIssue, type Issue, type IssueOut } from './issue.ts';
import { FacetPatterns, PatternUnusable, Validators, WholeRun } from './pipeline.ts';

/** Entities validated per step of a candidate scan. */
const SCAN_STEP = 512;

/** A candidate metamodel with what validates under it, all built over that one object. */
export type Candidate = {
	readonly metamodel: Metamodel;
	readonly validators: Validators;
	readonly patterns: FacetPatterns;
	readonly rules: CompiledRules | null;
};

/**
 * The candidate `doc` (a `GET /metamodel` document), its validators, facet
 * patterns and `rules(metamodel)`. Throws what `Metamodel.fromJSON` throws on
 * a malformed document, `PatternUnusable` when a facet pattern is one the host
 * cannot run, and `RulesUnreadable` when the compile is `unreadable`.
 */
export function prepareCandidate(doc: unknown, rules: (mm: Metamodel) => CompiledRules): Candidate {
	const metamodel = Metamodel.fromJSON(doc as MetamodelDoc);
	const patterns = new FacetPatterns(metamodel);
	if (patterns.unusable) throw new PatternUnusable();
	const compiled = rules(metamodel);
	if (compiled.unreadable) throw new RulesUnreadable('a candidate rule set is unreadable');
	return { metamodel, validators: new Validators(metamodel), patterns, rules: compiled };
}

/**
 * Every issue of `model` under the candidate, as one run over the whole
 * model answers them (`WholeRun`): the structure is built in steps, then the
 * elements and the relationships are validated `step` at a time, in state
 * order. Throws `PatternUnusable` when a subject makes a pattern fail on the
 * host. Nothing may write the model between two steps.
 */
export function* candidateScan(
	model: Model,
	c: Candidate,
	step: number = SCAN_STEP
): Steps<Issue[]> {
	const entities = model.elementCount + model.relationshipCount;
	const building = candidateStructureSteps(model, c.metamodel);
	let done = 0;
	let next = building.next();
	for (; next.done !== true; next = building.next()) {
		done = next.value.done;
		yield { done, total: next.value.total + entities };
	}
	const total = done + entities;
	const run = new WholeRun(model, c.validators, c.patterns, c.rules, next.value);
	let slice = 0;
	for (const el of model.elements()) {
		run.element(el);
		if (++slice === step) {
			done += slice;
			slice = 0;
			yield { done, total };
		}
	}
	for (const rel of model.relationships()) {
		run.relationship(rel);
		if (++slice === step) {
			done += slice;
			slice = 0;
			yield { done, total };
		}
	}
	if (slice > 0) yield { done: done + slice, total };
	return run.finish();
}

/** The model half of `POST /metamodel/diff`, in its field order. */
export type CandidateDiff = {
	now_failing: IssueOut[];
	now_passing: IssueOut[];
	unchanged_count: number;
	current_error_count: number;
	candidate_error_count: number;
};

/**
 * `current` (the store's issues) against `candidate`'s, both keyed by
 * `candidateKey`: a key keeps its first position and its last issue on each
 * side, as a dict built from the list does. `now_failing` is in candidate
 * order, `now_passing` in current order, `unchanged_count` counts the keys
 * both sides hold, and the error counts are the raw lengths. Every issue is
 * `on_server`.
 */
export function candidateDiff(
	current: Iterable<Issue>,
	candidate: readonly Issue[]
): CandidateDiff {
	const before = new Map<string, Issue>();
	let currentCount = 0;
	for (const issue of current) {
		before.set(candidateKey(issue), issue);
		currentCount++;
	}
	const after = new Map<string, Issue>();
	for (const issue of candidate) after.set(candidateKey(issue), issue);
	const diff: CandidateDiff = {
		now_failing: [],
		now_passing: [],
		unchanged_count: 0,
		current_error_count: currentCount,
		candidate_error_count: candidate.length
	};
	for (const [key, issue] of after) {
		if (!before.has(key)) diff.now_failing.push(wireIssue(issue, 'on_server'));
	}
	for (const [key, issue] of before) {
		if (after.has(key)) diff.unchanged_count++;
		else diff.now_passing.push(wireIssue(issue, 'on_server'));
	}
	return diff;
}

/**
 * `POST /commits/preview`'s body for a batch that rebinds the metamodel: the
 * whole working state's issues under the candidate, every one `on_server`,
 * the structural ones also as blockers. A rebind never blocks.
 */
export function rebindPreviewBody(issues: readonly Issue[]): PreviewBody {
	const body: PreviewBody = {
		conformance_error_count: 0,
		structural_blockers: [],
		issues: [],
		would_block: false
	};
	for (const issue of issues) {
		body.issues.push(wireIssue(issue, 'on_server'));
		if (issue.category === 'structural') {
			body.structural_blockers.push(wireIssue(issue, 'on_server'));
		} else body.conformance_error_count++;
	}
	return body;
}
