/**
 * Saved navigations and snippets inlined into a table, as `core/table/resolve.py`
 * does it, and whether the table reaches a script. A script column's snippet
 * ref, and those of the script steps of every navigation it holds, are
 * replaced by the snippet's code when a snippet fetch finds it; a dangling ref
 * stays and evaluates to the column's error. A table with a configured snippet
 * reaches a script whether its ref resolves or not.
 */
import type { ArtifactSet } from '../artifacts/artifact-set.ts';
import {
	navigationHasScript,
	NavigationResolveError,
	RefNotFoundError,
	resolveRefs,
	resolveSnippet,
	type Fetch,
	type SnippetFetch
} from '../navigation/resolve.ts';
import { ReadError } from '../read/errors.ts';
import { pyRepr } from '../value/repr.ts';
import {
	readTableDefinition,
	type Column,
	type NavigationSource,
	type TableDefinition
} from './schema.ts';

/** A saved table in the working copy: a staged one first, then the committed one. */
export function tableFetch(artifacts: ArtifactSet): (id: string) => TableDefinition {
	return (id) => {
		const artifact = artifacts.resolve(id);
		if (artifact === null || artifact.kind !== 'table') throw new RefNotFoundError(id);
		return readTableDefinition(artifact.payload, `artifact ${pyRepr(id)}`);
	};
}

// A source's own ref missing is the route's `unknown artifact <id>`; one
// nested in its operands is the navigation resolver's error.
function resolveSource(
	source: NavigationSource,
	fetch: Fetch,
	snippets?: SnippetFetch
): NavigationSource {
	if (source.ref === null && source.definition === null) return source;
	let base = source.definition;
	if (source.ref !== null) {
		try {
			base = fetch(source.ref);
		} catch (error) {
			if (error instanceof RefNotFoundError) {
				throw new ReadError(422, `unknown artifact ${source.ref}`);
			}
			throw error;
		}
	}
	try {
		return { ref: null, definition: resolveRefs(base!, fetch, new Set(), snippets) };
	} catch (error) {
		if (error instanceof NavigationResolveError) throw new ReadError(422, error.message);
		throw error;
	}
}

/**
 * A copy of `defn` with the row source's navigation and every navigation
 * column's inlined, refs nested in them included; an unconfigured one stays.
 * A ref that names no navigation refuses with 422. With `snippets`, every
 * script column's snippet ref, and every script step's in those navigations,
 * is inlined as well.
 */
export function resolveTableRefs(
	defn: TableDefinition,
	fetch: Fetch,
	snippets?: SnippetFetch
): TableDefinition {
	const rs = defn.row_source;
	const rowSource =
		rs.kind === 'scope' ? rs : { ...rs, navigation: resolveSource(rs.navigation, fetch, snippets) };
	const columns = defn.columns.map((col): Column => {
		if (col.kind === 'navigation') {
			return { ...col, navigation: resolveSource(col.navigation, fetch, snippets) };
		}
		if (col.kind === 'script') return { ...col, snippet: resolveSnippet(col.snippet, snippets) };
		return col;
	});
	return { ...defn, row_source: rowSource, columns };
}

/**
 * Whether evaluating a resolved `defn` may run a snippet: a script column
 * whose snippet is set, or a navigation holding a script step that is.
 */
export function tableHasScript(defn: TableDefinition): boolean {
	for (const col of defn.columns) {
		if (col.kind === 'script' && (col.snippet.ref !== null || col.snippet.definition !== null)) {
			return true;
		}
	}
	const rs = defn.row_source;
	if (rs.kind !== 'scope' && rs.navigation.definition !== null) {
		if (navigationHasScript(rs.navigation.definition)) return true;
	}
	return defn.columns.some(
		(col) =>
			col.kind === 'navigation' &&
			col.navigation.definition !== null &&
			navigationHasScript(col.navigation.definition)
	);
}
