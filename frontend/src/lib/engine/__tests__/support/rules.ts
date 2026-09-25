// Rule sets over the smart-city example, as the server parses them.
import type { ArtifactPayload, RulesParseOut } from '$lib/api/types';

export const RULES_KIND = 'validation_rules';

type Rule = { name: string; applies_to: string; then: object };

/** Holds on the one German `Organization` (`e_000001`): four issues, on `e_000002`…`e_000005`. */
export const DE_ONLY: Rule = {
	name: 'de-only',
	applies_to: 'Organization',
	then: { property: 'country', in: ['DE'] }
};

/** Holds on the German and the French `Organization`: three issues, on `e_000003`…`e_000005`. */
export const DE_OR_FR: Rule = {
	name: 'de-or-fr',
	applies_to: 'Organization',
	then: { property: 'country', in: ['DE', 'FR'] }
};

/** `POST /rules/parse`'s body for a set of `rules`. */
export const parsed = (...rules: Rule[]): RulesParseOut => ({
	ok: true,
	document: JSON.stringify({ rules }),
	errors: []
});

/** A document the engine's reader refuses: a key the grammar does not have. */
export const UNREADABLE: RulesParseOut = { ok: true, document: '{"rules":[],"x":1}', errors: [] };

/** The YAML a test stands for a set of `rules` with: any text, one per set. */
export const yamlOf = (...rules: Rule[]): string =>
	rules.map((rule) => `# ${rule.name}\n`).join('');

/** A committed rule set as `GET /artifacts/payloads` serves it. */
export function ruleSet(
	id: string,
	name: string,
	yaml: string,
	rules: RulesParseOut | null,
	rev = 1
): ArtifactPayload {
	return {
		id,
		kind: RULES_KIND,
		name,
		artifact_rev: rev,
		updated_at: '2026-09-25T00:00:00Z',
		updated_by: null,
		entry_points: null,
		payload: { schema_version: 1, yaml },
		rules
	};
}

/** The payload a rules editor stages for `yaml`. */
export const rulesPayload = (yaml: string) => ({ schema_version: 1, yaml });

/** A rule issue as the frontend's schema keeps it. */
export const ruleIssue = (rule: string, id: string, origin: string) => ({
	severity: 'error',
	message: `Rule '${rule}' violated`,
	target_ids: [id],
	check: `rule:${rule}`,
	origin
});

/** `rule`'s issues on the Organizations `ids` name, in id order. */
export const ruleIssues = (rule: string, ids: readonly string[], origin: string) =>
	ids.map((id) => ruleIssue(rule, id, origin));

export const NOT_DE = ['e_000002', 'e_000003', 'e_000004', 'e_000005'];
export const NOT_DE_OR_FR = ['e_000003', 'e_000004', 'e_000005'];
