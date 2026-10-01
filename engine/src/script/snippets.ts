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
