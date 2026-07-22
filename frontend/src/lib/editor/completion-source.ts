// Pure completion/hover logic for the snippet editor. All decisions live
// here (unit-tested without CM); CodeEditor.svelte only adapts these to
// CompletionContext/hoverTooltip. Detection is a bounded regex scan of the
// text before the cursor on the CURRENT line — multi-line calls get no
// completion (accepted spec limitation).

import type { FacadeDocEntry, Metamodel, SnippetDocsOut } from '$lib/api/types';

export interface VocabSummary {
	typeNames: string[];
}

export interface CompletionOption {
	label: string;
	detail?: string;
	info?: string;
	type: string;
	boost?: number;
}

export interface CompletionSpec {
	/** Offset into `before` where the completed token starts. */
	from: number;
	options: CompletionOption[];
}

/** Concrete element types only — `dr.create` rejects abstract ones. */
export function vocabFromMetamodel(mm: Metamodel | null): VocabSummary | null {
	if (!mm) return null;
	return {
		typeNames: mm.elements
			.filter((e) => !e.abstract)
			.map((e) => e.name)
			.sort((a, b) => a.localeCompare(b))
	};
}

const CM_TYPE: Record<string, string> = {
	function: 'function',
	method: 'method',
	property: 'property',
	exception: 'class'
};

// `boost` is only ever passed as -1 (the member-access heuristic, deprioritized
// below the typed-partial gate above). dr.*/type-string contexts don't need a
// positive counterpart: lang-python's keyword/local sources never fire in
// member-access or string-literal contexts, so this facade source is already
// the sole provider there with no competing options to outrank.
function facadeOptions(
	docs: SnippetDocsOut,
	prefix: 'dr.' | 'Element.' | 'Relationship.',
	partial: string,
	boost?: number
): CompletionOption[] {
	return docs.facade
		.filter((e) => e.name.startsWith(prefix))
		.map((e) => ({ entry: e, label: e.name.slice(prefix.length) }))
		.filter(({ label }) => label.startsWith(partial))
		.map(({ entry, label }) => ({
			label,
			detail: entry.signature,
			info: entry.doc,
			type: CM_TYPE[entry.kind] ?? 'text',
			...(boost !== undefined ? { boost } : {})
		}));
}

// Member-access heuristic: the receiver's class is unknown, so offer the
// union of Element and Relationship members, Element first, deduped by
// label (get/props/id/stereotype exist on both with identical docs shape).
function memberOptions(docs: SnippetDocsOut, partial: string, boost: number): CompletionOption[] {
	const element = facadeOptions(docs, 'Element.', partial, boost);
	const seen = new Set(element.map((o) => o.label));
	const rel = facadeOptions(docs, 'Relationship.', partial, boost).filter(
		(o) => !seen.has(o.label)
	);
	return [...element, ...rel];
}

// First string argument of dr.create( — stereotype name after the quote.
const CREATE_STRING_RE = /dr\.create\(\s*(["'])([A-Za-z_][A-Za-z0-9_]*)?$/;
// dr.elements( with an optional stereotypes= keyword, single string or list
// form (`stereotypes=["A", "` keeps completing later entries). Bounded scan
// of the current line, like everything here: every quantifier consumes at
// least one character and the inner class excludes quotes, so the repeated
// group can't backtrack catastrophically.
const ELEMENTS_STRING_RE =
	/dr\.elements\(\s*(?:stereotypes\s*=\s*)?(?:\[\s*(?:["'][^"']*["']\s*,\s*)*)?(["'])([A-Za-z_][A-Za-z0-9_]*)?$/;
const DR_MEMBER_RE = /(?:^|[^\w.])dr\.(\w*)$/;
const OTHER_MEMBER_RE = /(\w+|\)|\])\.(\w*)$/;

export function computeCompletions(
	before: string,
	docs: SnippetDocsOut | null,
	vocab: VocabSummary | null,
	explicit = false
): CompletionSpec | null {
	const typeMatch = CREATE_STRING_RE.exec(before) ?? ELEMENTS_STRING_RE.exec(before);
	if (typeMatch) {
		if (!vocab || vocab.typeNames.length === 0) return null;
		const partial = typeMatch[2] ?? '';
		const options = vocab.typeNames
			.filter((t) => t.startsWith(partial))
			.map((t) => ({ label: t, type: 'type' }));
		return options.length ? { from: before.length - partial.length, options } : null;
	}

	if (!docs) return null;

	const drMatch = DR_MEMBER_RE.exec(before);
	if (drMatch) {
		const partial = drMatch[1];
		const options = facadeOptions(docs, 'dr.', partial);
		return options.length ? { from: before.length - partial.length, options } : null;
	}

	const otherMatch = OTHER_MEMBER_RE.exec(before);
	if (otherMatch && otherMatch[1] !== 'dr') {
		const partial = otherMatch[2];
		// Heuristic — we don't know the receiver is an Element. Require a
		// typed partial (or an explicit request) so a bare `.` after any
		// paren doesn't pop noise, and rank below exact-context results.
		if (partial === '' && !explicit) return null;
		const options = memberOptions(docs, partial, -1);
		return options.length ? { from: before.length - partial.length, options } : null;
	}

	return null;
}

/** Resolve the facade entry for the word at `col` in `line`, or null. */
export function resolveDocAt(
	line: string,
	col: number,
	docs: SnippetDocsOut | null
): FacadeDocEntry | null {
	if (!docs) return null;
	let start = col;
	while (start > 0 && /\w/.test(line[start - 1])) start--;
	let end = col;
	while (end < line.length && /\w/.test(line[end])) end++;
	if (start === end) return null;
	const word = line.slice(start, end);
	if (line.slice(0, start).endsWith('dr.')) {
		return docs.facade.find((e) => e.name === `dr.${word}`) ?? null;
	}
	if (start > 0 && line[start - 1] === '.') {
		// Same heuristic as memberOptions: the receiver's class is unknown, so
		// prefer the Element entry and fall back to the Relationship one.
		return (
			docs.facade.find((e) => e.name === `Element.${word}`) ??
			docs.facade.find((e) => e.name === `Relationship.${word}`) ??
			null
		);
	}
	return null;
}
