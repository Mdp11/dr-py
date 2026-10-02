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

/**
 * The code of an exporter entry's transform, `label` naming the entry in the
 * refusal. Every failure is a 422, none degrading to an untransformed export: a
 * ref that is no snippet, a source that is neither a ref nor inline code. The
 * code's own entry point, `transform(doc)`, is not checked here.
 */
export function resolveTransformSource(
	artifacts: ArtifactSet,
	transform: EntryTransform,
	label: string
): string {
	if (transform.definition !== null) return transform.definition.code;
	if (transform.ref === null) throw new ReadError(422, `${label}: no transform configured`);
	const snippet = snippetFetch(artifacts)(transform.ref);
	if (snippet === null) {
		throw new ReadError(422, `${label}: unknown transform snippet ${transform.ref}`);
	}
	return snippet.code;
}
