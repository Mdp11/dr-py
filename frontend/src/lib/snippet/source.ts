// Pure predicates over the `SnippetSource` wire shape ({ ref?, definition? })
// — kept Svelte-free so a branch that depends on one is unit-testable
// (mirrors entry-stubs.ts / console-view.ts).
import type { SnippetSource } from '$lib/api/types';

/** True for the tolerant UNCONFIGURED source: neither `ref` nor `definition`
 * set. Mirrors core/script/schema.py's `SnippetSource.is_empty`; nullish
 * counts as empty too, so an absent `transform` field tests the same way.
 *
 * Every "is a snippet actually configured?" branch must ask this rather than
 * the field itself — `{}` is truthy in JS, and an unconfigured source would
 * otherwise read as a configured one. */
export function isEmptySnippetSource(source: SnippetSource | null | undefined): boolean {
	return source == null || (source.ref == null && source.definition == null);
}
