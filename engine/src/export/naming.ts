/**
 * The `${token}` template engine behind export naming, a port of
 * `core/table/naming.py`. One vocabulary, several contexts — `${name}` binds
 * to something different in each (a partition's display name for a split
 * filename, an exporter entry's table for its name and folder, the run's name
 * for its zip filename) — so `NAME_TOKENS`/`SPLIT_TOKENS` are separate
 * constants rather than one context-blind set.
 *
 * Two-phase, like the core: `validateTokens` runs up front (a typo shipped
 * silently into a filename contract is worse than a loud refusal), while
 * `substitute` never throws and leaves an unknown token verbatim, so it stays
 * safe to call on already-validated input.
 */
import { cmpCodePoint } from '../value/compare.ts';
import { pyStrip } from '../value/lower.ts';

const TOKEN_RE = /\$\{([^}]*)\}/g;

const CONTEXT_TOKENS: ReadonlySet<string> = new Set(['rev', 'date', 'project']);
/** Entry names, folder paths, the zip filename. */
export const NAME_TOKENS: ReadonlySet<string> = new Set([...CONTEXT_TOKENS, 'name']);
/** Split filenames additionally know the element id. */
export const SPLIT_TOKENS: ReadonlySet<string> = new Set([...NAME_TOKENS, 'id']);

/** Sanitized-stem length cap, in code points: well under any filesystem's limit
 * even after an extension and a `_NN` dedupe suffix. */
const MAX_FILENAME_LEN = 120;
const UNSAFE: ReadonlySet<string> = new Set(['/', '\\', ':', '*', '?', '"', '<', '>', '|']);

/** `template`'s tokens outside `allowed`, sorted, as the oracle's message; `null` when there are none. */
export function validateTokens(template: string, allowed: ReadonlySet<string>): string | null {
	const unknown = new Set<string>();
	for (const m of template.matchAll(TOKEN_RE)) {
		if (!allowed.has(m[1]!)) unknown.add(m[1]!);
	}
	if (unknown.size === 0) return null;
	const listed = [...unknown]
		.sort(cmpCodePoint)
		.map((t) => '${' + t + '}')
		.join(', ');
	return `unknown template token(s): ${listed}`;
}

/** `template` with every known `${token}` replaced by `vars`; an unknown one stays as written. */
export function substitute(template: string, vars: Readonly<Record<string, string>>): string {
	return template.replace(TOKEN_RE, (whole, token: string) =>
		Object.hasOwn(vars, token) ? vars[token]! : whole
	);
}

/** Whether `stripped` (already trimmed of leading/trailing dots) leaves nothing: `stem` is all dots. */
function allDots(stem: string): boolean {
	let start = 0;
	let end = stem.length;
	while (start < end && stem[start] === '.') start++;
	while (end > start && stem[end - 1] === '.') end--;
	return start === end;
}

/**
 * `name` as a safe filename/path-segment STEM, closing two zip-slip hazards:
 * an embedded `/`/`\` that would turn one path segment into several, and a
 * stem that is nothing but dots (`.`, `..`, ...), indistinguishable from a
 * self/parent-directory reference once used as a whole path segment.
 * `/\:*?"<>|` and control characters become `_`; the result is trimmed, cut
 * to 120 CODE POINTS and trimmed again; a stem left holding only dots becomes
 * that many `_`. Empty input stays empty (`""` is not "all dots") so a caller
 * falling back through `... || fallback || "element"` still reaches that
 * fallback.
 */
export function sanitizeStem(name: string): string {
	let cleaned = '';
	for (const ch of name) {
		cleaned += UNSAFE.has(ch) || ch.codePointAt(0)! < 32 ? '_' : ch;
	}
	cleaned = pyStrip(cleaned);
	cleaned = Array.from(cleaned).slice(0, MAX_FILENAME_LEN).join('');
	cleaned = pyStrip(cleaned);
	if (cleaned !== '' && allDots(cleaned)) cleaned = '_'.repeat(cleaned.length);
	return cleaned;
}

/**
 * Names taken so far, a new one deduplicated `_2`, `_3`, … against them: the
 * first of `base`, `base_2`, `base_3`, … not yet taken. A base's search
 * resumes at the suffix after the last one it claimed — names are only ever
 * added, so every candidate it passed is still taken — which keeps many
 * claims of one base linear while still stepping over a name taken
 * literally (an earlier `x_2` when `x` comes twice).
 */
export class TakenNames {
	private readonly names = new Set<string>();
	/** Per base claimed: the suffix its next search starts at (`1` stands for the bare base). */
	private readonly next = new Map<string, number>();

	has(name: string): boolean {
		return this.names.has(name);
	}

	add(name: string): void {
		this.names.add(name);
	}

	/** `base`, or the first free `base_n`, taken. */
	claim(base: string): string {
		let n = this.next.get(base) ?? 1;
		let candidate = n === 1 ? base : `${base}_${n}`;
		while (this.names.has(candidate)) candidate = `${base}_${++n}`;
		this.names.add(candidate);
		this.next.set(base, n + 1);
		return candidate;
	}
}

/** A folder template's refusal: the core's `ValueError` from `folder_segments`. */
export class FolderPathError extends Error {}

/** Path segments for a rendered folder template; `""` -> `[]` (root). */
export function folderSegments(rendered: string): string[] {
	if (rendered === '') return [];
	if (rendered.startsWith('/') || rendered.startsWith('\\')) {
		throw new FolderPathError('folder path must be relative');
	}
	return rendered.split('/').map((raw) => {
		const cleaned = sanitizeStem(raw);
		if (cleaned === '') throw new FolderPathError('folder path has an empty segment');
		return cleaned;
	});
}
