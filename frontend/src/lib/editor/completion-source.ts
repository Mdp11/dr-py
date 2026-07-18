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

function facadeOptions(
	docs: SnippetDocsOut,
	prefix: 'dr.' | 'Element.',
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

// First string argument of dr.create( / dr.type( — or dr.elements( with an
// optional type= keyword — with an optional partial type name after the quote.
const TYPE_STRING_RE =
	/dr\.(?:create|type|elements)\(\s*(?:type\s*=\s*)?(["'])([A-Za-z_][A-Za-z0-9_]*)?$/;
const DR_MEMBER_RE = /(?:^|[^\w.])dr\.(\w*)$/;
const OTHER_MEMBER_RE = /(\w+|\)|\])\.(\w*)$/;

export function computeCompletions(
	before: string,
	docs: SnippetDocsOut | null,
	vocab: VocabSummary | null,
	explicit = false
): CompletionSpec | null {
	const typeMatch = TYPE_STRING_RE.exec(before);
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
		const options = facadeOptions(docs, 'Element.', partial, -1);
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
		return docs.facade.find((e) => e.name === `Element.${word}`) ?? null;
	}
	return null;
}
