/**
 * Saved navigations inlined into a definition, as `core/navigation/resolve.py`
 * does it, and whether a definition reaches a script. A snippet ref needs no
 * resolving here: resolved or dangling, a script step with one reaches a
 * script all the same.
 */
import { pyRepr } from '../value/repr.ts';
import type { NavigationDefinition, Operand, SetExpression } from './schema.ts';

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

function resolveExpr(expr: SetExpression, fetch: Fetch, seen: ReadonlySet<string>): SetExpression {
	const operands = expr.operands.map((operand): Operand => {
		if (operand.ref !== null) {
			if (seen.has(operand.ref)) throw new RefCycleError(operand.ref);
			const inner = resolveRefs(fetch(operand.ref), fetch, new Set([...seen, operand.ref]));
			return { ref: null, definition: inner, step_index: operand.step_index };
		}
		return { ...operand, definition: resolveRefs(operand.definition!, fetch, seen) };
	});
	return { ...expr, operands };
}

/**
 * A copy of `defn` with every operand's ref replaced by the navigation it
 * names, resolved in turn. `seen` holds the ids being expanded on the path to
 * here: a navigation may appear twice side by side, never inside itself.
 */
export function resolveRefs(
	defn: NavigationDefinition,
	fetch: Fetch,
	seen: ReadonlySet<string> = new Set()
): NavigationDefinition {
	if (defn.kind === 'set_op') return resolveExpr(defn, fetch, seen);
	if (defn.start.kind !== 'set_op') return defn;
	return { ...defn, start: resolveExpr(defn.start, fetch, seen) };
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
