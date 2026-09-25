import { carriesPayload, type ArtifactSet } from '../artifacts/artifact-set.ts';
import { cmpCodePoint } from '../value/compare.ts';
import type { RuleSource, RulesParse } from './compile.ts';

export const RULES_KIND = 'validation_rules';

/**
 * The parse a rule set compiles from in the working layer: a staged payload's
 * own, `'pending'` standing on the last parse that arrived for the id, and
 * the committed parse under no staged payload. `null` is an artifact that
 * arrived without its parse; `undefined` leaves out a create whose first
 * parse is still out.
 */
function workingParse(set: ArtifactSet, id: string): RulesParse | null | undefined {
	const entry = set.stagedEntry(id);
	if (!carriesPayload(entry)) return set.committedArtifact(id)?.rules ?? null;
	const rules = entry.rules;
	if (rules === undefined) return null;
	if (rules !== 'pending') return rules;
	const last = set.lastWorkingParse(id);
	if (last !== undefined) return last;
	return set.committedArtifact(id) === undefined ? undefined : null;
}

/**
 * The rule sets of one layer of `set`, in the order they compile: by name,
 * then by id, both by code point. `committed` lists the committed rule sets
 * with their committed parse; `working` every id that resolves to a rule set
 * with the staged overlay laid over them.
 */
export function ruleSources(set: ArtifactSet, layer: 'committed' | 'working'): RuleSource[] {
	const out: RuleSource[] = [];
	for (const id of set.ids()) {
		if (layer === 'committed') {
			const artifact = set.committedArtifact(id);
			if (artifact?.kind === RULES_KIND) {
				out.push({ artifactId: id, name: artifact.name, parse: artifact.rules ?? null });
			}
			continue;
		}
		const resolved = set.resolve(id);
		if (resolved?.kind !== RULES_KIND) continue;
		const parse = workingParse(set, id);
		if (parse !== undefined) out.push({ artifactId: id, name: resolved.name, parse });
	}
	return out.sort(
		(a, b) => cmpCodePoint(a.name, b.name) || cmpCodePoint(a.artifactId, b.artifactId)
	);
}
