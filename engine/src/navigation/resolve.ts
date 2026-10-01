/**
 * Saved navigations and snippets inlined into a definition, as
 * `core/navigation/resolve.py` does it, and whether a definition reaches a
 * script. A script step's snippet ref is replaced by the snippet's code when a
 * snippet fetch is given and finds it; a dangling ref stays, and evaluates to
 * the step's error. Resolved or dangling, a script step reaches a script.
 */
import { pyRepr } from '../value/repr.ts';
import type {
	NavigationDefinition,
	NavigationStep,
	Operand,
	SetExpression,
	SnippetSource
} from './schema.ts';

/** A ref that makes a definition unevaluable; `message` is the core's text. */
export class NavigationResolveError extends Error {
	readonly artifactId: string;

	constructor(artifactId: string, message: string) {
		super(message);
		this.name = 'NavigationResolveError';
		this.artifactId = artifactId;
	}
}

/** A ref to no navigation: none under that id, or another kind of artifact. */
export class RefNotFoundError extends NavigationResolveError {
	constructor(artifactId: string) {
		super(artifactId, `unknown navigation artifact ${pyRepr(artifactId)}`);
		this.name = 'RefNotFoundError';
	}
}

/** A ref to a navigation already being expanded on the same path. */
export class RefCycleError extends NavigationResolveError {
	constructor(artifactId: string) {
		super(artifactId, `navigation reference cycle through ${pyRepr(artifactId)}`);
		this.name = 'RefCycleError';
	}
}

/** A saved navigation's definition; throws `RefNotFoundError` when there is none. */
export type Fetch = (id: string) => NavigationDefinition;

/** A saved snippet's code, or `null` for a ref that names none. */
export type SnippetFetch = (ref: string) => { code: string } | null;

/** `source` with its ref replaced by the snippet it names; a dangling ref, or no fetch, leaves it. */
export function resolveSnippet(source: SnippetSource, snippets?: SnippetFetch): SnippetSource {
	if (source.ref === null || snippets === undefined) return source;
	const snippet = snippets(source.ref);
	return snippet === null ? source : { ref: null, definition: { code: snippet.code } };
}

function resolveSteps(steps: NavigationStep[], snippets?: SnippetFetch): NavigationStep[] {
	if (snippets === undefined) return steps;
	let changed = false;
	const resolved = steps.map((step) => {
		if (step.kind !== 'script') return step;
		const snippet = resolveSnippet(step.snippet, snippets);
		if (snippet === step.snippet) return step;
		changed = true;
		return { ...step, snippet };
	});
	return changed ? resolved : steps;
}

function resolveExpr(
	expr: SetExpression,
	fetch: Fetch,
	seen: ReadonlySet<string>,
	snippets?: SnippetFetch
): SetExpression {
	const operands = expr.operands.map((operand): Operand => {
		if (operand.ref !== null) {
			if (seen.has(operand.ref)) throw new RefCycleError(operand.ref);
			const inner = resolveRefs(
				fetch(operand.ref),
				fetch,
				new Set([...seen, operand.ref]),
				snippets
			);
			return { ref: null, definition: inner, step_index: operand.step_index };
		}
		return { ...operand, definition: resolveRefs(operand.definition!, fetch, seen, snippets) };
	});
	return { ...expr, operands };
}

/**
 * A copy of `defn` with every operand's ref replaced by the navigation it
 * names, resolved in turn, and every script step's snippet ref by the snippet
 * it names. `seen` holds the ids being expanded on the path to here: a
 * navigation may appear twice side by side, never inside itself.
 */
export function resolveRefs(
	defn: NavigationDefinition,
	fetch: Fetch,
	seen: ReadonlySet<string> = new Set(),
	snippets?: SnippetFetch
): NavigationDefinition {
	if (defn.kind === 'set_op') return resolveExpr(defn, fetch, seen, snippets);
	const steps = resolveSteps(defn.steps, snippets);
	if (defn.start.kind !== 'set_op') return steps === defn.steps ? defn : { ...defn, steps };
	return { ...defn, start: resolveExpr(defn.start, fetch, seen, snippets), steps };
}

function setHasScript(expr: SetExpression): boolean {
	return expr.operands.some(
		(operand) => operand.definition !== null && navigationHasScript(operand.definition)
	);
}

/** Whether evaluating `defn` may run a snippet: a script step whose snippet is set, anywhere in it. */
export function navigationHasScript(defn: NavigationDefinition): boolean {
	if (defn.kind === 'set_op') return setHasScript(defn);
	const scripted = defn.steps.some(
		(step) =>
			step.kind === 'script' && (step.snippet.ref !== null || step.snippet.definition !== null)
	);
	if (scripted) return true;
	return defn.start.kind === 'set_op' && setHasScript(defn.start);
}
