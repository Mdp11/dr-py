// Pure helpers for the Test panel's named-input bindings — kept Svelte-free
// so the parsing/wire logic is unit-testable (mirrors entry-stubs.ts).
//
// A script column resolves `inputs[name]` from the referenced column's cell
// for the row being computed. A console run (`POST /snippets/run`) has no row
// to resolve from, so the panel binds each declared input by hand and ships
// it in the same wire shape the server already speaks
// (`core/script/runner.py`'s `WireInput`).

import type { SnippetRunInput } from '$lib/api/snippets';
import type { SnippetBoundElement } from '$lib/state';
import type { Column } from '$lib/api/types';

export type InputKind = 'elements' | 'scalars';

export interface DeclaredInput {
	name: string;
	/** Which control the binding row starts on — see `initialInputKind`. */
	kind: InputKind;
}

/** One input's bound value while the panel is open. `scalars` holds the raw
 * textarea text (not the parsed list) so a half-typed line survives a
 * re-render. */
export type InputBinding =
	| { kind: 'elements'; elements: SnippetBoundElement[] }
	| { kind: 'scalars'; text: string };

export function emptyBinding(kind: InputKind): InputBinding {
	return kind === 'elements' ? { kind, elements: [] } : { kind, text: '' };
}

/** Which control an input's row starts on, from the kind of the column it
 * reads. A HINT only: a navigation column ending in a property projection
 * holds scalars, and a script column holds whatever its snippet returned, so
 * the row's own kind selector always wins over this. */
export function initialInputKind(column: Column | undefined): InputKind {
	return column?.kind === 'element' || column?.kind === 'navigation' ? 'elements' : 'scalars';
}

/** One value per line, JSON-decoded where the line is valid JSON (`3`,
 * `true`, `null`, `"a, b"`) and kept as a plain string where it isn't
 * (`Building One`). Blank lines are dropped — a trailing newline must not
 * bind an extra empty string; write `""` to bind one deliberately. */
export function parseScalarLines(text: string): unknown[] {
	const out: unknown[] = [];
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (trimmed === '') continue;
		try {
			out.push(JSON.parse(trimmed));
		} catch {
			out.push(trimmed);
		}
	}
	return out;
}

/** The `inputs` map for a run body, in declaration order. Every declared name
 * is always sent — an unbound input ships as an empty list rather than being
 * omitted, so `inputs[name]` is present (and empty) instead of raising
 * KeyError inside the snippet. */
export function toWireInputs(
	declared: DeclaredInput[],
	bindings: Record<string, InputBinding>
): Record<string, SnippetRunInput> {
	const out: Record<string, SnippetRunInput> = {};
	for (const { name, kind } of declared) {
		const bound = bindings[name] ?? emptyBinding(kind);
		out[name] =
			bound.kind === 'scalars'
				? { kind: 'scalars', values: parseScalarLines(bound.text) }
				: { kind: 'elements', ids: bound.elements.map((e) => e.id) };
	}
	return out;
}
