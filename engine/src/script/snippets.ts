/**
 * Saved snippets as the working copy holds them: a staged one first, then the
 * committed one. A table's script column and a navigation's script step take
 * theirs tolerantly, a dangling ref left for the evaluation to report; an
 * export's transform takes its own strictly, since a transform that is
 * silently skipped ships a document untransformed.
 */
import type { ArtifactSet } from '../artifacts/artifact-set.ts';
import type { EntryTransform } from '../export/schema.ts';
import type { SnippetFetch } from '../navigation/resolve.ts';
import { ReadError } from '../read/errors.ts';
import { entryArities } from './arity.ts';
import { pyRepr } from '../value/repr.ts';
import { PyFloat, type Value } from '../value/types.ts';

/** The kind of a snippet artifact, as the server stores it. */
export const SNIPPET_KIND = 'code_snippet';

/** The longest inline snippet, in characters (`SNIPPET_MAX_CODE_BYTES`). */
export const SNIPPET_MAX_CODE_CHARS = 64 * 1024;

// What Rust's `str::trim` takes off, which is what pydantic's text-to-int conversion strips.
const SPACE = '\\t-\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const INT_TEXT = new RegExp(`^[${SPACE}]*[+-]?[0-9]+(?:_[0-9]+)*(?:\\.0+)?[${SPACE}]*$`);

/** Whether pydantic's lax `int` takes `value`: an int, a bool, an integral float inside 64 bits, or text of one. */
function laxInt(value: unknown): boolean {
	if (typeof value === 'bigint' || typeof value === 'boolean') return true;
	if (typeof value === 'number') return Number.isInteger(value);
	if (value instanceof PyFloat) {
		return Number.isInteger(value.value) && Math.abs(value.value) < 2 ** 63;
	}
	return typeof value === 'string' && INT_TEXT.test(value);
}

/**
 * Refuses an inline snippet definition the core's `SnippetDefinition` refuses,
 * with 422: `code` a string of at most 64 Ki characters, `language` `python`,
 * `entry_points` a list of strings, `schema_version` an integer as pydantic
 * reads one. Other keys are ignored. `where` names the definition in the refusal.
 */
export function checkSnippetDefinition(definition: object, where: string): void {
	const d = definition as { readonly [key: string]: unknown };
	const refuse = (message: string): never => {
		throw new ReadError(422, `${where}.${message}`);
	};
	if (!Object.hasOwn(d, 'code')) refuse('code: field required');
	const { code } = d;
	if (typeof code !== 'string') refuse('code: must be a string');
	else if (/\p{Cs}/u.test(code)) refuse('code: must be valid unicode');
	else if (code.length > SNIPPET_MAX_CODE_CHARS && [...code].length > SNIPPET_MAX_CODE_CHARS) {
		refuse(`code: must hold at most ${SNIPPET_MAX_CODE_CHARS} characters`);
	}
	if (Object.hasOwn(d, 'language') && d['language'] !== 'python') {
		refuse("language: must be 'python'");
	}
	if (Object.hasOwn(d, 'entry_points')) {
		const points = d['entry_points'];
		if (!Array.isArray(points) || !points.every((point) => typeof point === 'string')) {
			refuse('entry_points: must be a list of strings');
		}
	}
	if (Object.hasOwn(d, 'schema_version') && !laxInt(d['schema_version'])) {
		refuse('schema_version: must be an integer');
	}
}

function codeOf(payload: Value): Value | undefined {
	const holdsCode =
		typeof payload === 'object' &&
		payload !== null &&
		!Array.isArray(payload) &&
		!(payload instanceof PyFloat) &&
		Object.hasOwn(payload, 'code');
	return holdsCode ? (payload as { [key: string]: Value })['code'] : undefined;
}

/**
 * The code of the saved snippet `ref` names; `null` when no artifact does, or
 * the one under it is another kind. A snippet whose payload holds no code
 * refuses with 422.
 */
export function snippetFetch(artifacts: ArtifactSet): SnippetFetch {
	return (ref) => {
		const artifact = artifacts.resolve(ref);
		if (artifact === null || artifact.kind !== SNIPPET_KIND) return null;
		const code = codeOf(artifact.payload);
		if (typeof code !== 'string') {
			throw new ReadError(422, `artifact ${pyRepr(ref)}.code: must be a string`);
		}
		return { code };
	};
}

const NO_TRANSFORM = 'does not define a one-argument top-level transform(doc)';

/**
 * The code of an exporter entry's transform, `label` naming the entry in the
 * refusal. Every failure is a 422, none degrading to an untransformed export: a
 * ref that is no snippet, a source that is neither a ref nor inline code, code that
 * does not parse (inline only: a saved snippet is not parsed first) or that defines no
 * top-level `transform(doc)` (any of several taking one argument is one, as
 * `derive_entry_points` has it). Unparseable is what `entryArities` can see of it; a
 * syntax error it cannot see is the guest's, answered when the transform runs, and
 * `transformSyntaxRefusal` is the refusal for it.
 */
export function resolveTransformSource(
	artifacts: ArtifactSet,
	transform: EntryTransform,
	label: string
): string {
	if (transform.definition !== null) {
		const { code } = transform.definition;
		const arities = entryArities(code, 'transform');
		if (arities === null) throw new ReadError(422, `${label}: transform code does not parse`);
		if (!arities.includes(1)) {
			throw new ReadError(422, `${label}: transform code ${NO_TRANSFORM}`);
		}
		return code;
	}
	if (transform.ref === null) throw new ReadError(422, `${label}: no transform configured`);
	const snippet = snippetFetch(artifacts)(transform.ref);
	if (snippet === null) {
		throw new ReadError(422, `${label}: unknown transform snippet ${transform.ref}`);
	}
	if (!(entryArities(snippet.code, 'transform') ?? []).includes(1)) {
		throw new ReadError(422, `${label}: snippet ${transform.ref} ${NO_TRANSFORM}`);
	}
	return snippet.code;
}

/**
 * The refusal of a transform whose code the guest could not compile, which the oracle's
 * `ast.parse` refuses before anything runs: inline code does not parse, a saved snippet that
 * does not parse defines no transform.
 */
export function transformSyntaxRefusal(transform: EntryTransform, label: string): string {
	return transform.definition !== null
		? `${label}: transform code does not parse`
		: `${label}: snippet ${transform.ref} ${NO_TRANSFORM}`;
}
